# One-Time Setup (Maintainer Runbook)

Steps to take this repo from local build to fully automated publishing. Consumers never need any of this — see [README.md](README.md).

## 1. Local build & backfill

```bash
npm install
npm run build

# yt-dlp is required for ingestion (not for the published server)
winget install yt-dlp   # or: pipx install yt-dlp

# Full playlist backfill (set OPENAI_API_KEY for embeddings / semantic search)
OPENAI_API_KEY=sk-... node dist/scripts/ingest.js
```

Review the "No guest extracted" list at the end of the run and fix any misses in `scripts/lib/guest-overrides.json`, then apply with `node dist/scripts/ingest.js --reextract` (rebuilds guests + tool mentions from stored data, no re-download).

## 2. GitHub repo + first database release

```bash
git init && git add -A && git commit -m "Initial commit"
gh repo create darrenjrobinson/EntraNewsPodcastMCPServer --public --source . --push

# Secret used by the weekly ingest workflow
gh secret set OPENAI_API_KEY

# First database release (the runtime download path depends on this)
gh release create "db-$(date -u +%Y.%m.%d)-0001" \
  --title "Initial database" --latest ./entra-news-podcasts.db
```

Verify the runtime download path: delete `~/.entra-news-podcast-mcp/`, run the server **without** `ENTRA_PODCAST_DB_PATH`, and confirm it downloads the release asset.

The repo must be **public** — both for release-asset downloads and for MCP Registry github-oidc namespace auth.

## 3. First npm publish (manual)

npm Trusted Publishing cannot create a *new* package, so v0.1.0 is published by hand:

```bash
npm login          # darrenjrobinson
npm pack --dry-run # verify tarball: dist/, package.json, README, LICENSE, server.json only
npm publish
```

## 4. Configure npm Trusted Publishing

npmjs.com → `entra-news-podcast-mcp` → Settings → **Trusted Publisher** → GitHub Actions:

| Field | Value |
|---|---|
| Owner | `darrenjrobinson` |
| Repository | `EntraNewsPodcastMCPServer` |
| Workflow filename | `publish-mcp.yml` |

After this, every `v*` tag publishes tokenlessly with provenance.

## 5. First MCP Registry publish

Either push the `v0.1.0` tag (the workflow's `mcp-publisher login github-oidc` handles auth), or publish manually once:

```bash
curl -L "https://github.com/modelcontextprotocol/registry/releases/latest/download/mcp-publisher_$(uname -s | tr '[:upper:]' '[:lower:]')_$(uname -m | sed 's/x86_64/amd64/;s/aarch64/arm64/').tar.gz" | tar xz mcp-publisher
./mcp-publisher login github     # interactive device flow
./mcp-publisher publish
```

## 6. Verify automation

```bash
# Weekly ingest (manual trigger)
gh workflow run weekly-update.yml -f mode=incremental

# Publish pipeline
git tag v0.1.0 && git push origin v0.1.0
```

If the weekly workflow fails with `BOT_BLOCKED`, YouTube is refusing the runner's IP — consumers are unaffected (the last release stays `latest`); refresh manually per the README's "Manual database refresh" section.

## Load-bearing constants (change together if renaming anything)

| Where | Value |
|---|---|
| `src/db/client.ts` `GITHUB_REPO` | `darrenjrobinson/EntraNewsPodcastMCPServer` |
| `src/db/client.ts` `DB_FILENAME` | `entra-news-podcasts.db` (must equal the release asset name) |
| `package.json` `name` / `server.json` `packages[0].identifier` | `entra-news-podcast-mcp` |
| `package.json` `mcpName` / `server.json` `name` | `io.github.darrenjrobinson/entra-news-podcast` |
| Versions | git tag `vX.Y.Z` == `package.json` == `server.json` (×2) — CI-enforced |
