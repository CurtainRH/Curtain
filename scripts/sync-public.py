#!/usr/bin/env python3
"""Publish local `main` to the public repo with every identity rewritten.

    git fast-export main  ->  rewrite author/committer/tagger  ->  git fast-import (public-main)
    git push origin-public public-main:main --force

Local `main` and `origin/main` are never touched, so Vercel/Lovable keep their hashes.
The rewrite is deterministic: the same `main` always yields the same public-main hashes,
so repeated syncs only add new commits on the public side.
"""

import re
import subprocess
import sys

PUBLIC_NAME = b"CurtainRH"
PUBLIC_EMAIL = b"curtainsrh@atomicmail.io"
SOURCE_BRANCH = "main"
PUBLIC_BRANCH = "public-main"
PUBLIC_REMOTE = "origin-public"

# Paths left out of the public history: `--exclude <prefix>` (repeatable). Used when the public
# token lacks GitHub's `workflow` scope, which is required to push .github/workflows/ files.
EXCLUDE: list[bytes] = []

IDENT = re.compile(rb"^(author|committer|tagger) .*? <[^>]*> (\d+) [+-]\d{4}\n$")


def run(*args, **kw):
    return subprocess.run(["git", *args], check=True, **kw)


def rewrite(src, dst):
    """Stream-rewrite a fast-export stream. `data <n>` payloads are copied byte-for-byte."""
    while True:
        line = src.readline()
        if not line:
            return
        if line.startswith(b"data "):
            dst.write(line)
            size = int(line[5:].strip())
            dst.write(src.read(size))
            continue
        if EXCLUDE and (line.startswith(b"M ") or line.startswith(b"D ")):
            path = line.rstrip(b"\n").split(b" ", 3)[-1] if line.startswith(b"M ") else line[2:].rstrip(b"\n")
            if any(path.startswith(prefix) for prefix in EXCLUDE):
                continue
        m = IDENT.match(line)
        if m:
            line = b"%s %s <%s> %s +0000\n" % (m.group(1), PUBLIC_NAME, PUBLIC_EMAIL, m.group(2))
        elif line.startswith(b"commit refs/heads/%s" % SOURCE_BRANCH.encode()):
            line = b"commit refs/heads/%s\n" % PUBLIC_BRANCH.encode()
        elif line.startswith(b"reset refs/heads/%s" % SOURCE_BRANCH.encode()):
            line = b"reset refs/heads/%s\n" % PUBLIC_BRANCH.encode()
        dst.write(line)


def main():
    push = "--no-push" not in sys.argv
    args = sys.argv[1:]
    for i, a in enumerate(args):
        if a == "--exclude" and i + 1 < len(args):
            EXCLUDE.append(args[i + 1].encode())

    exporter = subprocess.Popen(
        ["git", "fast-export", "--signed-tags=strip", "--tag-of-filtered-object=drop", SOURCE_BRANCH],
        stdout=subprocess.PIPE,
    )
    importer = subprocess.Popen(["git", "fast-import", "--force", "--quiet"], stdin=subprocess.PIPE)
    rewrite(exporter.stdout, importer.stdin)
    importer.stdin.close()
    if exporter.wait() != 0 or importer.wait() != 0:
        sys.exit("fast-export/fast-import failed")

    idents = run("log", "--format=%an <%ae>|%cn <%ce>", PUBLIC_BRANCH, capture_output=True).stdout.decode()
    expected = f"{PUBLIC_NAME.decode()} <{PUBLIC_EMAIL.decode()}>"
    leaked = {i for line in idents.splitlines() for i in line.split("|") if i != expected}
    if leaked:
        sys.exit(f"refusing to push, unexpected identities on {PUBLIC_BRANCH}: {sorted(leaked)}")

    count = run("rev-list", "--count", PUBLIC_BRANCH, capture_output=True).stdout.decode().strip()
    print(f"{PUBLIC_BRANCH}: {count} commits, all as {expected}")

    if push:
        run("push", PUBLIC_REMOTE, f"{PUBLIC_BRANCH}:main", "--force")


if __name__ == "__main__":
    main()
