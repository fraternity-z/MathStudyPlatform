#!/usr/bin/env python3
"""Run a small private frozen retrieval set and atomically publish node-exporter metrics."""
import argparse
import hashlib
import json
from pathlib import Path
import ssl
import tempfile
import time
import urllib.parse
import urllib.request


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise RuntimeError("redirect denied")


def evaluate(base, cases, token, ca_file):
    origin = urllib.parse.urlsplit(base)
    if origin.scheme != "https" or not origin.hostname or origin.username or origin.password or origin.query or origin.fragment:
        raise ValueError("HTTPS API origin required")
    if not isinstance(cases, list) or not 1 <= len(cases) <= 20:
        raise ValueError("probe must contain one to twenty frozen cases")
    opener = urllib.request.build_opener(NoRedirect(), urllib.request.HTTPSHandler(context=ssl.create_default_context(cafile=ca_file)))

    def fetch(route, payload=None):
        data = None if payload is None else json.dumps(payload).encode()
        req = urllib.request.Request(base.rstrip("/") + route, data=data,
                                     headers={"Authorization": "Bearer " + token, "Content-Type": "application/json"})
        with opener.open(req, timeout=15) as response:
            if "no-store" not in response.headers.get("Cache-Control", ""):
                raise RuntimeError("response must not be cacheable")
            return json.loads(response.read(1024 * 1024 + 1))

    matched = 0
    for case in cases:
        response = fetch("/resources/search", {"query": case["query"], "top_k": 5})
        if response["degraded"]:
            raise RuntimeError("probe degraded")
        hits = response["items"]
        expected = set(case["expected_resource_ids"])
        if not expected:
            raise ValueError("positive probe cases must identify expected resources")
        matched += len(expected.intersection(hit["citation"]["resource_id"] for hit in hits)) / len(expected)
        for hit in hits:
            citation = hit["citation"]
            query = urllib.parse.urlencode({key: citation[key] for key in ("knowledge_base_id", "document_version_id", "generation")})
            resolved = fetch("/resources/citations/" + urllib.parse.quote(citation["chunk_id"], safe="") + "?" + query)
            if resolved["citation"] != citation or hashlib.sha256(resolved["content"].encode()).hexdigest() != citation["quote_hash"]:
                raise RuntimeError("citation changed or checksum mismatch")
    return matched / len(cases)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--api-base", required=True)
    parser.add_argument("--cases", required=True)
    parser.add_argument("--token-file", required=True)
    parser.add_argument("--ca-file")
    parser.add_argument("--metrics-file", required=True)
    args = parser.parse_args()
    success, recall = 0, 0.0
    try:
        token = Path(args.token_file).read_text(encoding="utf-8").strip()
        cases = json.loads(Path(args.cases).read_text(encoding="utf-8"))
        recall = evaluate(args.api_base, cases, token, args.ca_file)
        success = int(recall >= 0.9)
    except Exception:
        pass
    destination = Path(args.metrics_file).resolve()
    with tempfile.NamedTemporaryFile(mode="w", dir=destination.parent, delete=False, encoding="utf-8") as output:
        temporary = Path(output.name)
        output.write(f"msp_vector_quality_probe_success {success}\nmsp_vector_quality_probe_recall_at_5 {recall}\nmsp_vector_quality_probe_timestamp_seconds {time.time():.0f}\n")
    try:
        temporary.replace(destination)
    finally:
        temporary.unlink(missing_ok=True)
    print(json.dumps({"success": bool(success), "recall_at_5": recall}))
    return 0 if success else 1


if __name__ == "__main__":
    raise SystemExit(main())
