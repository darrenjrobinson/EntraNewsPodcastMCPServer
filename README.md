# Entra.Chat Podcast MCP Server

[![npm version](https://img.shields.io/npm/v/entra-news-podcast-mcp)](https://www.npmjs.com/package/entra-news-podcast-mcp)
[![npm downloads](https://img.shields.io/npm/dt/entra-news-podcast-mcp)](https://www.npmjs.com/package/entra-news-podcast-mcp)
[![MIT License](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

An MCP (Model Context Protocol) server for searching transcripts of **[Entra.Chat](https://www.youtube.com/playlist?list=PL06Jj3_onEzEBGRfA7Zddg1IrjgpU1eGp)** — Merill Fernando's Microsoft Entra podcast on YouTube. Ask your AI assistant about Entra ID features, community tools, and identity topics discussed on the show, and get answers with **timestamped YouTube links** that jump straight to the relevant moment.

Companion to [entra-news-mcp](https://github.com/darrenjrobinson/EntraNewsMCPServer) (the written Entra.News newsletter archive) and [microsoft-ai-roundup-mcp](https://github.com/darrenjrobinson/MicrosoftAIRoundupMCPServer).

## How it works

- **Zero per-user infrastructure.** Install via NPX; the transcript database (SQLite) is downloaded automatically from this repo's GitHub Releases on first run and cached locally (`~/.entra-news-podcast-mcp/`). Updates are checked weekly.
- **Hybrid retrieval.** BM25 keyword search (in-memory inverted index with Porter stemming — ideal for exact names like "PIM for Groups" or "Maester" in messy spoken-word transcripts) fused with OpenAI semantic vector search via Reciprocal Rank Fusion. No API key? Keyword search works out of the box.
- **Timestamped deep links.** Every search result links to `youtube.com/watch?v=...&t=...` so you can hear the discussion in context.
- **Guest knowledge.** Guests are extracted per episode with their profile links (LinkedIn, Twitter/X, GitHub, Bluesky) — ask "which episodes was X on?" or "who has been on the show?".
- **Fresh weekly.** A GitHub Action re-ingests the playlist every week and publishes an updated database release.

## Installation

Requires Node.js **22+** (uses the built-in `node:sqlite` — no native dependencies).

### Claude Desktop

Add to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "entra-podcasts": {
      "command": "npx",
      "args": ["-y", "entra-news-podcast-mcp"],
      "env": {
        "OPENAI_API_KEY": "sk-..."
      }
    }
  }
}
```

The `OPENAI_API_KEY` is **optional** — it enables semantic/hybrid search (embedding the query costs a fraction of a cent). Without it, BM25 keyword search is used.

### Claude Code

```bash
claude mcp add entra-podcasts -- npx -y entra-news-podcast-mcp
```

### VS Code (GitHub Copilot)

```json
{
  "servers": {
    "entra-podcasts": {
      "command": "npx",
      "args": ["-y", "entra-news-podcast-mcp"]
    }
  }
}
```

### Cursor

```json
{
  "mcpServers": {
    "entra-podcasts": {
      "command": "npx",
      "args": ["-y", "entra-news-podcast-mcp"]
    }
  }
}
```

## Tools

| Tool | Description |
|------|-------------|
| `search_entra_podcasts` | Search all episode transcripts. Modes: `hybrid` (default, BM25 + semantic via RRF), `semantic`, `keyword`. Results include episode, guests, and timestamped YouTube links. |
| `get_episode` | Full episode by `video_id` or `date` — metadata, guests with profile links, chapters with timestamped links, and the complete transcript with `[mm:ss]` markers. |
| `list_episodes` | Browse the archive; filter by `year`, `month`, and/or `guest` name. |
| `list_guests` | Directory of all podcast guests with profile links, appearance counts, and latest appearance. |
| `get_guest` | One guest by name: profile links and **every episode they appeared on**. |
| `find_tool_mentions` | Community tools discussed on the show, with timestamped links to hear the discussion. |

### Example prompts

- *"What did Merill and his guests say about PIM for Groups?"*
- *"Which episodes has Jane Doe been on? What's her LinkedIn?"*
- *"Find where Maester was discussed and give me the YouTube timestamp."*
- *"List the Entra.Chat episodes from March 2026."*

## Data & freshness

| | |
|---|---|
| Source | [Entra.Chat playlist](https://www.youtube.com/playlist?list=PL06Jj3_onEzEBGRfA7Zddg1IrjgpU1eGp) on YouTube (@merillx) |
| Transcripts | YouTube captions (uploaded captions preferred, auto-generated otherwise) |
| Refresh | Weekly GitHub Action → new `db-*` release |
| Local cache | `~/.entra-news-podcast-mcp/` (`%USERPROFILE%\.entra-news-podcast-mcp\` on Windows) — update check at most every 7 days; delete the folder to force a fresh download |
| Runtime override | Set `ENTRA_PODCAST_DB_PATH` to use a local database file instead |

## Development

```bash
npm install
npm run build

# Ingest (requires yt-dlp on PATH: pipx install yt-dlp / winget install yt-dlp)
node dist/scripts/ingest.js --limit 2        # test with 2 videos
node dist/scripts/ingest.js                  # full playlist backfill
node dist/scripts/ingest.js --incremental    # only new videos
node dist/scripts/ingest.js --video <id>     # one video (re-ingests)
node dist/scripts/ingest.js --reextract      # rebuild guests + tool mentions from stored
                                             # data (no network) — after editing
                                             # guest-overrides.json or known-tools.ts
node dist/scripts/ingest.js --embed-missing  # embed chunks that have no embedding yet
                                             # (needs OPENAI_API_KEY; no YouTube access)

# Run the server against a local DB
ENTRA_PODCAST_DB_PATH=./entra-news-podcasts.db npx @modelcontextprotocol/inspector node dist/src/index.js
```

Set `OPENAI_API_KEY` during ingest to generate embeddings (semantic search); without it the ingest still completes and BM25 keyword search works.

### Guest extraction overrides

Guests are extracted heuristically from video titles/descriptions. Episodes the heuristics miss are listed at the end of each ingest run — correct them in [scripts/lib/guest-overrides.json](scripts/lib/guest-overrides.json) (keyed by `video_id`, entries fully replace extraction for that video) and apply with `node dist/scripts/ingest.js --reextract` (no re-download needed).

### PO token provider (yt-dlp caption downloads)

YouTube's caption/`timedtext` endpoint returning 429 has (at least) two distinct, unrelated causes — the ingest log's `CAPTION_RATE_LIMITED` error can't tell you which from the message text alone:

1. No PO (Proof-of-Origin) token supplied for the `web`/`web_safari` clients yt-dlp uses by default — see the [yt-dlp PO Token Guide](https://github.com/yt-dlp/yt-dlp/wiki/PO-Token-Guide).
2. The video has multiple audio/dub tracks and resolved to the translated caption bucket rather than a native `<lang>-orig` transcript — see `pickCaptionLanguage` in `scripts/lib/ytdlp.ts`. Confirmed 2026-09-09: this still 429s even with a working PO token provider.

**Regardless of source IP** — confirmed 2026-09-09 by reproducing the identical failure from four different exit IPs (two IPRoyal residential identities in two countries, plus a clean home residential IP with no proxy at all). A proxy does not fix either cause.

CI sets up the PO token provider automatically (`.github/workflows/weekly-update.yml`, "Set up PO token provider" step, version-pinned — see that step's comment). For local ingest runs, set it up once:

```bash
# 1. Provider (script mode — spawns per request, no persistent server needed).
#    The server (git tag) and plugin (PyPI package, step 2) are separately
#    versioned and must match — check the pinned version in
#    .github/workflows/weekly-update.yml ($BGUTIL_VERSION) rather than
#    grabbing "latest" for one and not the other.
git clone --single-branch --branch 2.0.0 \
  https://github.com/Brainicism/bgutil-ytdlp-pot-provider.git \
  ~/bgutil-ytdlp-pot-provider   # %USERPROFILE%\bgutil-ytdlp-pot-provider on Windows — this exact path, yt-dlp looks here by default
cd ~/bgutil-ytdlp-pot-provider/server
npm ci
npx tsc

# 2. Plugin — install into the SAME Python env yt-dlp itself runs under
#    (check with `python -c "import sys; print(sys.executable)"` vs `yt-dlp` on
#    PATH — a mismatch here is a common trap and yt-dlp will silently not see
#    the plugin). If yt-dlp was installed via pipx: `pipx inject yt-dlp bgutil-ytdlp-pot-provider==2.0.0`
python3 -m pip install -U bgutil-ytdlp-pot-provider==2.0.0

# Verify a WORKING provider — not just a listed one. yt-dlp lists an entry
# even when it's unusable, suffixed "(external, unavailable)"; a real one
# reads "(external)" with nothing else in the parens.
yt-dlp -v --skip-download --simulate "https://www.youtube.com/watch?v=jNQXAC9IVRw" 2>&1 \
  | grep -E "bgutil:script-(node|deno)-[0-9.]+ \(external\)"
```

### Manual database refresh (if YouTube blocks CI)

YouTube sometimes blocks general page/API requests from datacenter IPs (`BOT_BLOCKED` in the workflow log — distinct from `CAPTION_RATE_LIMITED` above, which is captions-specific and not IP-related). Consumers are unaffected either way — the last-good release stays `latest`.

Mitigations built in before falling back to a manual refresh:

- CI installs [Deno](https://deno.com/), which yt-dlp requires as a JS runtime to solve YouTube's player challenges — without it, requests are far more likely to be flagged as bot traffic.
- The `YTDLP_PROXY` repository secret (set since 2026-07-21 to a residential proxy URL in `http://user:pass@host:port` form — note IPRoyal's dashboard shows `host:port:user:pass`, which must be rewritten, and geo-targeting modifiers like `_country-au_city-hurstville` are appended to the **password**, not the username) routes all yt-dlp traffic through that proxy. The same env var works for local ingest runs. This only helps with `BOT_BLOCKED`, not `CAPTION_RATE_LIMITED`.

If CI is still blocked, refresh manually from a residential IP (set up the PO token provider above first):

```bash
node dist/scripts/ingest.js --incremental
gh release create "db-$(date -u +%Y.%m.%d)-9999" \
  --repo darrenjrobinson/EntraNewsPodcastMCPServer \
  --title "Database Update (manual)" --latest \
  ./entra-news-podcasts.db
```

## Release process (maintainer)

Code releases (`v*` tags) publish to npm (Trusted Publishing / OIDC, no tokens) and the MCP Registry (`io.github.darrenjrobinson/entra-news-podcast`) via `.github/workflows/publish-mcp.yml`:

1. Bump `version` in `package.json` **and both version fields in `server.json`** (CI enforces lockstep).
2. Commit, then `git tag v0.x.y && git push origin main v0.x.y`.

Database releases (`db-*` tags) are produced by the weekly workflow and never trigger an npm publish.

## License

MIT © [Darren Robinson](https://github.com/darrenjrobinson)
