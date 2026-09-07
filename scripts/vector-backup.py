#!/usr/bin/env python3
"""Encrypted, manifest-verified PostgreSQL/object/Qdrant recovery bundles.

Requires Python 3, PostgreSQL clients and age. Credentials use PGSERVICE/
PGPASSFILE and file paths; no secrets are accepted as command arguments.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import ssl
import subprocess
import tarfile
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise RuntimeError("backup endpoint redirects are forbidden")


def run(args, **kwargs):
    result = subprocess.run(args, stderr=subprocess.DEVNULL, **kwargs)
    if result.returncode:
        raise RuntimeError("external backup command failed: " + Path(args[0]).name)
    return result


def checksum(path):
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def request(opener, base, route, key, method="GET"):
    req = urllib.request.Request(base + route, method=method, headers={"api-key": key})
    return opener.open(req, timeout=120)


def snapshot_nodes(args, work):
    if not args.nodes:
        raise RuntimeError("all Qdrant peer endpoints are required")
    key = Path(args.api_key_file).read_text(encoding="utf-8").strip()
    if not key or len(key) > 4096:
        raise RuntimeError("invalid Qdrant key file")
    opener = urllib.request.build_opener(NoRedirect(), urllib.request.HTTPSHandler(
        context=ssl.create_default_context(cafile=args.ca_file)))
    records = []
    for index, base in enumerate(args.nodes):
        parsed = urllib.parse.urlsplit(base)
        if parsed.scheme != "https" or not parsed.hostname or parsed.username or parsed.password or parsed.query or parsed.fragment or parsed.path not in ("", "/"):
            raise RuntimeError("peer endpoints must be HTTPS origins without credentials")
        base = base.rstrip("/")
        with request(opener, base, "/collections", key) as response:
            collections = json.load(response)["result"]["collections"]
        for collection in collections:
            name = collection["name"]
            if not re.fullmatch(r"resource_[0-9a-f]{32}_[0-9a-f]{32}", name):
                continue
            with request(opener, base, "/collections/" + name + "/snapshots", key, "POST") as response:
                snapshot = json.load(response)["result"]["name"]
            if not re.fullmatch(r"[A-Za-z0-9_.-]+", snapshot):
                raise RuntimeError("invalid snapshot identity")
            route = "/collections/" + name + "/snapshots/" + urllib.parse.quote(snapshot, safe="")
            destination = work / "qdrant" / (str(index) + "-" + name + ".snapshot")
            destination.parent.mkdir(exist_ok=True)
            with request(opener, base, route, key) as response, destination.open("xb") as output:
                shutil.copyfileobj(response, output, length=1024 * 1024)
            records.append({"peer": index, "collection": name, "file": destination.relative_to(work).as_posix()})
    return records


def safe_objects(source, destination):
    source = source.resolve(strict=True)
    if not source.is_dir():
        raise RuntimeError("object export must be a directory")
    destination.mkdir()
    for item in source.rglob("*"):
        if item.is_symlink() or not item.resolve().is_relative_to(source):
            raise RuntimeError("object export must not contain links")
        target = destination / item.relative_to(source)
        if item.is_dir():
            target.mkdir(exist_ok=True)
        elif item.is_file():
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(item, target)
        else:
            raise RuntimeError("object export contains a special file")


def backup(args, work):
    if not args.writers_stopped:
        raise RuntimeError("stop API, workers and object writers before backup")
    output = Path(args.bundle).resolve()
    if output.exists():
        raise RuntimeError("backup destination already exists")
    started = time.time()
    run(["pg_dump", "--format=custom", "--no-owner", "--no-acl", "--file=" + str(work / "postgres.dump")])
    safe_objects(Path(args.objects), work / "objects")
    snapshots = snapshot_nodes(args, work)
    files = {p.relative_to(work).as_posix(): checksum(p) for p in sorted(work.rglob("*")) if p.is_file()}
    manifest = {"format": 1, "started_at": started, "completed_at": time.time(), "files": files,
                "snapshots": snapshots, "object_contract": "restore the same private namespace before enabling readers"}
    (work / "manifest.json").write_text(json.dumps(manifest, indent=2), encoding="utf-8")
    archive = work.parent / "bundle.tar"
    with tarfile.open(archive, "w") as tar:
        for path in sorted(work.iterdir()):
            tar.add(path, arcname=path.name)
    # age authenticates the whole encrypted archive; a partial file is never published.
    partial = output.with_name(output.name + ".partial")
    if partial.exists():
        raise RuntimeError("partial backup already exists")
    try:
        with partial.open("xb") as destination:
            run(["age", "--encrypt", "--recipients-file", args.recipients_file, str(archive)], stdout=destination)
        partial.replace(output)
    finally:
        partial.unlink(missing_ok=True)
    return {"result": "backed_up", "sha256": checksum(output), "files": len(files), "peer_snapshots": len(snapshots)}


def unpack(args, work):
    archive = work.parent / "bundle.tar"
    run(["age", "--decrypt", "--identity", args.identity_file, "--output", str(archive), args.bundle])
    with tarfile.open(archive) as tar:
        for member in tar:
            path = Path(member.name)
            if path.is_absolute() or ".." in path.parts or "\\" in member.name or ":" in member.name or not (member.isfile() or member.isdir()):
                raise RuntimeError("unsafe recovery archive")
            target = work / path
            if member.isdir():
                target.mkdir(parents=True, exist_ok=True)
            else:
                target.parent.mkdir(parents=True, exist_ok=True)
                with tar.extractfile(member) as source, target.open("xb") as output:
                    shutil.copyfileobj(source, output)
    manifest = json.loads((work / "manifest.json").read_text(encoding="utf-8"))
    if manifest.get("format") != 1:
        raise RuntimeError("unsupported backup format")
    actual = {p.relative_to(work).as_posix(): checksum(p) for p in work.rglob("*") if p.is_file() and p != work / "manifest.json"}
    if actual != manifest["files"]:
        raise RuntimeError("backup checksum or inventory mismatch")
    run(["pg_restore", "--list", str(work / "postgres.dump")], stdout=subprocess.DEVNULL)
    return manifest


def restore(args, work):
    if not args.writers_stopped or not args.empty_target:
        raise RuntimeError("restore requires stopped writers and an isolated empty target")
    if not os.environ.get("PGDATABASE"):
        raise RuntimeError("restore requires an explicit PGDATABASE")
    objects = Path(args.objects).resolve()
    if objects.exists() and any(objects.iterdir()):
        raise RuntimeError("object target is not empty")
    result = run(["psql", "-XAt", "--set=ON_ERROR_STOP=1", "--command=SELECT count(*) FROM pg_tables WHERE schemaname='public'"], stdout=subprocess.PIPE)
    if result.stdout.strip() != b"0":
        raise RuntimeError("PostgreSQL target is not empty")
    # Restore sources first. Keep the application stopped on any partial failure.
    objects.mkdir(parents=True, exist_ok=True)
    shutil.copytree(work / "objects", objects, dirs_exist_ok=True)
    run(["pg_restore", "--exit-on-error", "--single-transaction", "--no-owner", "--no-acl", "--dbname=" + os.environ.get("PGDATABASE", "postgres"), str(work / "postgres.dump")])
    return {"result": "sources_restored", "next": "restore private storage configuration and encryption key; rebuild, validate and promote generations before enabling vector reads"}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=["backup", "verify", "restore"])
    parser.add_argument("--bundle", required=True)
    parser.add_argument("--objects")
    parser.add_argument("--nodes", nargs="+")
    parser.add_argument("--api-key-file")
    parser.add_argument("--ca-file")
    parser.add_argument("--recipients-file")
    parser.add_argument("--identity-file")
    parser.add_argument("--writers-stopped", action="store_true")
    parser.add_argument("--empty-target", action="store_true")
    args = parser.parse_args()
    required = ["objects", "nodes", "api_key_file", "recipients_file"] if args.command == "backup" else ["identity_file"]
    if args.command == "restore":
        required.append("objects")
    if any(not getattr(args, name) for name in required):
        parser.error("missing command-specific backup or recovery arguments")
    os.umask(0o077)
    with tempfile.TemporaryDirectory(prefix="msp-vector-backup-") as temporary:
        work = Path(temporary) / "data"
        work.mkdir(mode=0o700)
        if args.command == "backup":
            result = backup(args, work)
        else:
            manifest = unpack(args, work)
            result = restore(args, work) if args.command == "restore" else {"result": "verified", "files": len(manifest["files"])}
        print(json.dumps(result))


if __name__ == "__main__":
    try:
        main()
    except Exception:
        # Provider URLs, database errors and filesystem details can contain secrets.
        raise SystemExit("vector backup operation failed; verify inputs, dependencies and private service access") from None
