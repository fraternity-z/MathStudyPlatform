#!/usr/bin/env python3
"""Run bounded concurrent retrieval and citation checks on a frozen private dataset."""
import argparse
from concurrent.futures import ThreadPoolExecutor
import hashlib
import importlib.util
import json
import math
import os
from pathlib import Path
import threading
import time


_spec = importlib.util.spec_from_file_location("vector_quality", Path(__file__).with_name("vector-quality-evaluate.py"))
quality = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(quality)


def validate_limits(workers, rounds, duration, max_searches, p95_ms, p99_ms):
    if (type(workers) is not int or not 1 <= workers <= 32
            or type(rounds) is not int or not 1 <= rounds <= 10000
            or type(max_searches) is not int or not 1 <= max_searches <= 100000
            or not math.isfinite(duration) or not 0 <= duration <= 3600
            or not math.isfinite(p95_ms) or not math.isfinite(p99_ms)
            or not 0 < p95_ms <= p99_ms <= 60000):
        raise quality.EvaluationError("invalid_load_limits")


def run_load(cases, fetch_factory, *, workers=5, rounds=1, duration=0,
             max_searches=10000, p95_ms=1000, p99_ms=3000):
    """Each request is reauthorized; no responses, identities or credentials are retained."""
    validate_limits(workers, rounds, duration, max_searches, p95_ms, p99_ms)
    # Validate before starting any network traffic, including library callers.
    quality.validate_dataset({"format": 1, "version": "load", "cases": cases})
    required = len(cases) * rounds
    if required > max_searches:
        raise quality.EvaluationError("search_budget_below_rounds")
    started = time.perf_counter()
    lock = threading.Lock()
    next_case = 0
    totals = {name: 0 for name in ("positive", "no_answer", "permission", "degraded", "citations",
                                 "normal_positive", "degraded_positive")}
    sums = {group: [0.0, 0.0, 0.0] for group in ("positive", "normal_positive", "degraded_positive")}
    # Bounded by max_searches; failed requests consume budget and keep their latency.
    latencies, failures = [], {}
    checked, passed_citations = 0, 0

    def worker():
        nonlocal next_case, checked, passed_citations
        fetch = fetch_factory()
        while True:
            with lock:
                elapsed = time.perf_counter() - started
                if next_case >= max_searches or (next_case >= required and elapsed >= duration):
                    return
                ordinal = next_case
                next_case += 1
            samples = []

            def timed_fetch(actor, route, payload=None):
                before = time.perf_counter()
                try:
                    return fetch(actor, route, payload)
                finally:
                    if payload is not None:
                        samples.append((time.perf_counter() - before) * 1000)

            result = quality.evaluate([cases[ordinal % len(cases)]], timed_fetch)
            with lock:
                checked += 1
                latencies.extend(samples)
                for name in totals:
                    totals[name] += result["counts"][name]
                for group in sums:
                    metrics = result["metrics"] if group == "positive" else result["quality_by_mode"][group]
                    for i, name in enumerate(("recall_at_5", "mrr_at_5", "ndcg_at_5")):
                        sums[group][i] += (metrics[name] or 0) * result["counts"][group]
                passed_citations += round((result["metrics"]["citations_pass_rate"] or 0) * result["counts"]["citations"])
                for failure in result["failures"]:
                    # Codes originate in the evaluator, never raw provider exceptions.
                    code = failure["code"]
                    failures[code] = failures.get(code, 0) + 1

    with ThreadPoolExecutor(max_workers=workers) as executor:
        futures = [executor.submit(worker) for _ in range(workers)]
        for future in futures:
            future.result()
    elapsed = time.perf_counter() - started
    groups = {group: {name: value / totals[group] if totals[group] else None
                      for name, value in zip(("recall_at_5", "mrr_at_5", "ndcg_at_5"), values)}
              for group, values in sums.items()}
    quality_passed = all(all(value is not None and value >= threshold for value, threshold in
                             zip(group.values(), (.90, .85, .85))) for group in groups.values())
    missing = [name for name, count in totals.items() if not count]
    p95, p99 = quality.percentile(latencies, .95), quality.percentile(latencies, .99)
    duration_passed = elapsed >= duration
    capacity_passed = (checked >= required and duration_passed and len(latencies) == checked
                       and p95 is not None and p95 <= p95_ms and p99 <= p99_ms)
    return {"format": 1, "scope": "retrieval_load", "success": bool(not failures and not missing and quality_passed and capacity_passed),
            "workers": workers, "searches": checked, "complete_rounds": checked // len(cases),
            "elapsed_seconds": elapsed, "searches_per_second": checked / elapsed if elapsed else 0,
            "requested_duration_seconds": duration, "duration_passed": duration_passed,
            "budget_exhausted": checked == max_searches, "counts": totals,
            "quality_by_mode": groups, "quality_passed": quality_passed, "capacity_passed": capacity_passed,
            "citation_pass_rate": passed_citations / totals["citations"] if totals["citations"] else None,
            "missing_coverage": missing, "failure_counts": failures,
            "search_latency_ms": {"samples": len(latencies), "p50": quality.percentile(latencies, .50), "p95": p95, "p99": p99},
            "thresholds": {"p95_ms": p95_ms, "p99_ms": p99_ms, "recall_at_5": .90, "mrr_at_5": .85, "ndcg_at_5": .85},
            "tutor_no_answer": "not_evaluated", "resource_leaks": "not_evaluated", "ingestion_backlog": "not_evaluated"}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--api-base", required=True)
    parser.add_argument("--dataset", required=True)
    parser.add_argument("--dataset-sha256", required=True)
    parser.add_argument("--tokens-file", required=True)
    parser.add_argument("--ca-file")
    parser.add_argument("--report", required=True)
    parser.add_argument("--workers", type=int, default=5)
    parser.add_argument("--rounds", type=int, default=1)
    parser.add_argument("--duration-seconds", type=float, default=0)
    parser.add_argument("--max-searches", type=int, default=10000)
    parser.add_argument("--p95-ms", type=float, default=1000)
    parser.add_argument("--p99-ms", type=float, default=3000)
    args = parser.parse_args()
    os.umask(0o077)
    try:
        destination = Path(args.report).resolve()
        inputs = [args.dataset, args.tokens_file] + ([args.ca_file] if args.ca_file else [])
        if any(destination == Path(path).resolve() for path in inputs):
            raise quality.EvaluationError("report_overlaps_input")
        dataset, digest = quality.read_json(args.dataset)
        if args.dataset_sha256 != digest:
            raise quality.EvaluationError("dataset_checksum_mismatch")
        cases = quality.validate_dataset(dataset)
        tokens, _ = quality.read_json(args.tokens_file)
        quality.make_fetch(args.api_base, tokens, args.ca_file)
        if any(case["actor"] not in tokens for case in cases):
            raise quality.EvaluationError("missing_actor_token")
        report = run_load(cases, lambda: quality.make_fetch(args.api_base, tokens, args.ca_file),
                          workers=args.workers, rounds=args.rounds, duration=args.duration_seconds,
                          max_searches=args.max_searches, p95_ms=args.p95_ms, p99_ms=args.p99_ms)
        report.update(dataset_sha256=digest, evaluator_sha256=hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
                      quality_evaluator_sha256=hashlib.sha256(Path(quality.__file__).read_bytes()).hexdigest(),
                      completed_at_unix=int(time.time()))
        quality.write_report(destination, report)
        print(json.dumps({"success": report["success"], "searches": report["searches"], "dataset_sha256": digest}))
        return 0 if report["success"] else 1
    except Exception as error:
        code = str(error) if isinstance(error, quality.EvaluationError) else "load_io_or_input_failed"
        print(json.dumps({"success": False, "code": code}))
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
