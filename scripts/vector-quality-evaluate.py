#!/usr/bin/env python3
"""Evaluate a private, versioned retrieval dataset through the authenticated API.

Reports contain aggregate measurements and input checksums, never queries,
resource identities, credentials or provider error messages. No model activation,
index mutation, fault injection or Tutor request is performed.
"""
import argparse
import hashlib
import json
import math
import os
from pathlib import Path
import ssl
import tempfile
import time
import urllib.parse
import urllib.request


class EvaluationError(Exception):
    """A fixed, safe diagnostic code, optionally tied to a dataset row."""


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise EvaluationError("redirect_denied")


def read_json(path):
    with Path(path).open("rb") as source:
        raw = source.read(8 * 1024 * 1024 + 1)
    if len(raw) > 8 * 1024 * 1024:
        raise EvaluationError("input_too_large")
    return json.loads(raw), hashlib.sha256(raw).hexdigest()


def identifiers(value):
    return (isinstance(value, list) and len(value) <= 1000
            and all(isinstance(item, str) and 0 < len(item) <= 128 for item in value)
            and len(value) == len(set(value)))


def validate_dataset(dataset):
    if not isinstance(dataset, dict) or dataset.get("format") != 1:
        raise EvaluationError("invalid_dataset_format")
    if not isinstance(dataset.get("version"), str) or not dataset["version"].strip():
        raise EvaluationError("missing_dataset_version")
    cases = dataset.get("cases")
    if not isinstance(cases, list) or not 1 <= len(cases) <= 1000:
        raise EvaluationError("invalid_case_count")
    for index, case in enumerate(cases, 1):
        if not isinstance(case, dict):
            raise EvaluationError(f"invalid_case:{index}")
        expected, allowed = case.get("expected_resource_ids"), case.get("allowed_resource_ids")
        valid = (case.get("kind") in ("positive", "no_answer", "permission")
                 and isinstance(case.get("query"), str) and 0 < len(case["query"].strip()) <= 2000
                 and isinstance(case.get("actor"), str) and bool(case["actor"].strip())
                 and isinstance(case.get("knowledge_base_id"), str) and bool(case["knowledge_base_id"].strip())
                 and identifiers(expected) and identifiers(allowed)
                 and type(case.get("expected_degraded")) is bool
                 and case.get("expected_mode") in ("hybrid", "fts_only", "vector_only", "none"))
        if not valid or not set(expected).issubset(allowed):
            raise EvaluationError(f"invalid_case:{index}")
        if (case["kind"] == "positive" and not expected) or (case["kind"] != "positive" and expected):
            raise EvaluationError(f"invalid_relevance_labels:{index}")
    return cases


def make_fetch(base, tokens, ca_file):
    origin = urllib.parse.urlsplit(base)
    if (origin.scheme != "https" or not origin.hostname or origin.username or origin.password
            or origin.query or origin.fragment):
        raise EvaluationError("https_api_base_required")
    if (not isinstance(tokens, dict) or not tokens
            or any(not isinstance(value, str) or not value or len(value) > 16384
                   or any(char.isspace() for char in value) for value in tokens.values())):
        raise EvaluationError("invalid_actor_tokens")
    opener = urllib.request.build_opener(NoRedirect(), urllib.request.HTTPSHandler(
        context=ssl.create_default_context(cafile=ca_file)))

    def fetch(actor, route, payload=None):
        if actor not in tokens:
            raise EvaluationError("missing_actor_token")
        request = urllib.request.Request(base.rstrip("/") + route,
                                         data=None if payload is None else json.dumps(payload).encode(),
                                         headers={"Authorization": "Bearer " + tokens[actor],
                                                  "Content-Type": "application/json"})
        try:
            with opener.open(request, timeout=15) as response:
                directives = {part.strip().lower() for part in response.headers.get("Cache-Control", "").split(",")}
                if "no-store" not in directives:
                    raise EvaluationError("cacheable_response")
                raw = response.read(1024 * 1024 + 1)
                if len(raw) > 1024 * 1024:
                    raise EvaluationError("response_too_large")
                return json.loads(raw)
        except EvaluationError:
            raise
        except Exception:
            raise EvaluationError("request_failed") from None
    return fetch


def ranking_metrics(resource_ids, expected, k=5):
    # Duplicate chunks of one resource consume rank positions but earn gain once.
    seen, gains = set(), []
    for resource_id in resource_ids[:k]:
        gains.append(int(resource_id in expected and resource_id not in seen))
        seen.add(resource_id)
    recall = sum(gains) / len(expected) if expected else 0.0
    reciprocal = next((1 / rank for rank, gain in enumerate(gains, 1) if gain), 0.0)
    ideal = sum(1 / math.log2(rank + 1) for rank in range(1, min(k, len(expected)) + 1))
    dcg = sum(gain / math.log2(rank + 1) for rank, gain in enumerate(gains, 1))
    return recall, reciprocal, dcg / ideal if ideal else 0.0


def percentile(values, fraction):
    return sorted(values)[max(0, math.ceil(len(values) * fraction) - 1)] if values else None


def evaluate(cases, fetch):
    totals = {name: 0 for name in ("positive", "no_answer", "permission", "degraded", "citations",
                                 "normal_positive", "degraded_positive")}
    passed = {name: 0 for name in ("no_answer", "permission", "degradation", "citations")}
    scores, latencies, failures = [], [], []
    group_scores = {"normal_positive": [], "degraded_positive": []}
    for index, case in enumerate(cases, 1):
        totals[case["kind"]] += 1
        totals["degraded"] += int(case["expected_degraded"])
        group = "degraded_positive" if case["expected_degraded"] else "normal_positive"
        if case["kind"] == "positive":
            totals[group] += 1
        stage = "search"
        try:
            started = time.perf_counter()
            response = fetch(case["actor"], "/resources/search", {
                "query": case["query"], "knowledge_base_id": case["knowledge_base_id"], "top_k": 5})
            latencies.append((time.perf_counter() - started) * 1000)
            if not isinstance(response, dict) or type(response.get("degraded")) is not bool:
                raise EvaluationError("invalid_search_response")
            hits, adjacent = response.get("items"), response.get("adjacent", [])
            if not isinstance(hits, list) or len(hits) > 5 or not isinstance(adjacent, list) or len(adjacent) > 100:
                raise EvaluationError("invalid_search_items")
            if response["degraded"] == case["expected_degraded"] and response.get("mode") == case["expected_mode"]:
                passed["degradation"] += 1
            else:
                failures.append({"case": index, "code": "unexpected_degradation"})
            ids = [hit["citation"]["resource_id"] for hit in hits]
            all_ids = [hit["citation"]["resource_id"] for hit in hits + adjacent]
            if not set(all_ids).issubset(case["allowed_resource_ids"]):
                raise EvaluationError("unauthorized_resource")
            if case["kind"] == "permission":
                passed["permission"] += 1
            if case["kind"] == "no_answer":
                # Strict retrieval abstention only; this does not measure Tutor refusal.
                if not hits and not adjacent:
                    passed["no_answer"] += 1
                else:
                    failures.append({"case": index, "code": "no_answer_has_candidates"})
            case_score = ranking_metrics(ids, set(case["expected_resource_ids"]))
            stage = "citation"
            for hit in hits + adjacent:
                totals["citations"] += 1
                citation = hit["citation"]
                if citation["knowledge_base_id"] != case["knowledge_base_id"]:
                    raise EvaluationError("citation_scope_mismatch")
                query = urllib.parse.urlencode({key: citation[key] for key in
                                                ("knowledge_base_id", "document_version_id", "generation")})
                resolved = fetch(case["actor"], "/resources/citations/" +
                                 urllib.parse.quote(citation["chunk_id"], safe="") + "?" + query)
                if (resolved["citation"] != citation
                        or hashlib.sha256(resolved["content"].encode()).hexdigest() != citation["quote_hash"]
                        or hit["content"] != resolved["content"]):
                    raise EvaluationError("citation_mismatch")
                passed["citations"] += 1
            if case["kind"] == "positive":
                scores.append(case_score)
                group_scores[group].append(case_score)
        except Exception as error:
            code = str(error) if isinstance(error, EvaluationError) else "invalid_" + stage + "_response"
            failures.append({"case": index, "code": code})
    # Failed positives remain in the denominator; failures can never improve quality.
    metrics = {name: sum(score[i] for score in scores) / totals["positive"] if totals["positive"] else None
               for i, name in enumerate(("recall_at_5", "mrr_at_5", "ndcg_at_5"))}
    for name in ("no_answer", "permission", "citations"):
        metrics[name + "_pass_rate"] = passed[name] / totals[name] if totals[name] else None
    metrics["degradation_pass_rate"] = passed["degradation"] / len(cases)
    missing = [name for name, count in totals.items() if count == 0]
    quality_passed = (metrics["recall_at_5"] is not None and metrics["recall_at_5"] >= 0.90
                      and metrics["mrr_at_5"] >= 0.85 and metrics["ndcg_at_5"] >= 0.85)
    groups = {}
    for group, values in group_scores.items():
        groups[group] = {name: sum(score[i] for score in values) / totals[group] if totals[group] else None
                         for i, name in enumerate(("recall_at_5", "mrr_at_5", "ndcg_at_5"))}
        if totals[group]:
            quality_passed = quality_passed and all(value >= threshold for value, threshold in
                                                   zip(groups[group].values(), (.90, .85, .85)))
    return {"format": 1, "scope": "retrieval_only", "success": not failures and not missing and quality_passed,
            "counts": totals, "metrics": metrics, "quality_passed": quality_passed, "quality_by_mode": groups,
            "missing_coverage": missing, "failures": failures,
            "search_latency_ms": {"samples": len(latencies), "p50": percentile(latencies, .50),
                                  "p95": percentile(latencies, .95), "p99": percentile(latencies, .99)},
            "tutor_no_answer": "not_evaluated", "capacity_slo": "not_evaluated"}


def write_report(destination, report):
    destination = Path(destination).resolve()
    with tempfile.NamedTemporaryFile(mode="w", dir=destination.parent, delete=False, encoding="utf-8") as output:
        temporary = Path(output.name)
        try:
            json.dump(report, output, indent=2, allow_nan=False)
            output.write("\n")
        except Exception:
            output.close()
            temporary.unlink(missing_ok=True)
            raise
    try:
        temporary.replace(destination)
    finally:
        temporary.unlink(missing_ok=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--api-base", required=True)
    parser.add_argument("--dataset", required=True)
    parser.add_argument("--dataset-sha256", required=True)
    parser.add_argument("--tokens-file", required=True)
    parser.add_argument("--ca-file")
    parser.add_argument("--report", required=True)
    args = parser.parse_args()
    os.umask(0o077)
    try:
        destination = Path(args.report).resolve()
        inputs = [args.dataset, args.tokens_file] + ([args.ca_file] if args.ca_file else [])
        if any(destination == Path(path).resolve() for path in inputs):
            raise EvaluationError("report_overlaps_input")
        dataset, digest = read_json(args.dataset)
        if args.dataset_sha256 != digest:
            raise EvaluationError("dataset_checksum_mismatch")
        cases = validate_dataset(dataset)
        tokens, _ = read_json(args.tokens_file)
        fetch = make_fetch(args.api_base, tokens, args.ca_file)
        if any(case["actor"] not in tokens for case in cases):
            raise EvaluationError("missing_actor_token")
        report = evaluate(cases, fetch)
        report["dataset_sha256"] = digest
        report["evaluator_sha256"] = hashlib.sha256(Path(__file__).read_bytes()).hexdigest()
        report["thresholds"] = {"recall_at_5": .90, "mrr_at_5": .85, "ndcg_at_5": .85,
                                "citations_pass_rate": 1, "permission_pass_rate": 1,
                                "no_answer_pass_rate": 1, "degradation_pass_rate": 1}
        report["completed_at_unix"] = int(time.time())
        write_report(destination, report)
        print(json.dumps({"success": report["success"], "dataset_sha256": digest,
                          "failed_checks": len(report["failures"]), "missing_coverage": report["missing_coverage"]}))
        return 0 if report["success"] else 1
    except Exception as error:
        code = str(error) if isinstance(error, EvaluationError) else "evaluation_io_or_input_failed"
        print(json.dumps({"success": False, "code": code}))
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
