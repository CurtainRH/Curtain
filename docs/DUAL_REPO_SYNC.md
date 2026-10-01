# Dual-Repository Sync

Curtain lives in two GitHub repos built from one local `main`.

## 1. Architecture

| Property | Private (deployment) | Public (open source) |
| :--- | :--- | :--- |
| **GitHub** | `NotADeveloper7/curtain` | `CurtainRH/curtain` |
| **Git remote** | `origin` | `origin-public` |
| **Branch** | `main` | `main` (pushed from local `public-main`) |
| **Author** | `NAD7 <notadeveloper7@outlook.com>` | `CurtainRH <curtainsrh@atomicmail.io>` |
| **Integrations** | Vercel (frontend), Lovable | GitHub Actions CI, GHCR image, backend deploy hook |

Local commits are authored as NAD7. This is set in this repo's `.git/config`:

```bash
git config user.name "NAD7" && git config user.email "notadeveloper7@outlook.com"
```

## 2. Commands

Run from the repo root.

```bash
bun run push:origin   # private only: git push origin main
bun run push:public   # public only: python3 scripts/sync-public.py
bun run push:all      # private first, then public
```

Dry run (build `public-main` without pushing):

```bash
python3 scripts/sync-public.py --no-push
```

## 3. How the public sync works

[`scripts/sync-public.py`](../scripts/sync-public.py):

1. `git fast-export main` streams the full history with exact timestamps, messages and trees.
2. Every `author`, `committer` and `tagger` line is rewritten to `CurtainRH <curtainsrh@atomicmail.io>`. `data` payloads (file contents and messages) are copied byte for byte, so binaries are safe.
3. `git fast-import` writes the result to local `public-main`.
4. The script refuses to push if any other identity is left on `public-main`.
5. `git push origin-public public-main:main --force`

The rewrite is deterministic, so each sync only appends new commits on the public side. Local `main` and `origin/main` keep their original hashes, so Lovable and Vercel are never disturbed.

**Important**
- **Only identities are rewritten.** Commit messages and file contents are published as-is. Never commit secrets, and never put private names in messages.
- **Public `main` is force-overwritten on every sync.** Anything pushed directly to the public repo (for example, merged external PRs) must first be brought into private `main`, or the next sync will erase it.
- **Never force-push `origin`.** Lovable is connected to it, and rewriting its history breaks the Lovable project.

**Leaving paths out.** `--exclude <prefix>` (repeatable) drops those paths from the public history. Use `--exclude .github/workflows/` when the public token lacks GitHub's `workflow` scope, which is required to push workflow files.

## 4. Layout

The frontend stays at the repo root because Lovable and Vercel build from there. The backend Bun workspace lives in `backend/`. Product docs live in `docs/`. See the root [README](../README.md).

## 5. Verifying

```bash
git remote -v
# origin          https://ghp_...@github.com/NotADeveloper7/curtain.git
# origin-public   https://ghp_...@github.com/CurtainRH/curtain.git

git log -n 5 --format="%h %an <%ae> %s" public-main
```

Tokens live only in this repo's `.git/config` remote URLs. To rotate a token:

```bash
git remote set-url origin        https://<NEW_TOKEN>@github.com/NotADeveloper7/curtain.git
git remote set-url origin-public https://<NEW_TOKEN>@github.com/CurtainRH/curtain.git
```
