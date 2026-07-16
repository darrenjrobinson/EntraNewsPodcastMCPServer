# Project: Entra News Podcasts — YouTube Transcript Ingestion & MCP

> **Status:** Revised (2026-07-16) — hybrid FTS5-BM25 + vector retrieval
> **Proposed by:** Doc
> **Channel source:** https://youtube.com/@merillx (Merill Fernando — Entra News podcast)
> **Revision:** Added FTS5-BM25 as primary retrieval layer with vector search as secondary (hybrid RRF fusion)

## Problem

The Entra News DB captures the **written** newsletter (229 issues, 2,042 chunks). But Merill also publishes video episodes on YouTube covering Entra ID changes, community tools, and identity news — and that content often contains insight, context, and nuance that doesn't make it into the written newsletter.

We need a parallel pipeline that:
1. Ingests YouTube transcripts from Merill's channel
2. Chunks and embeds them for semantic/vector search
3. Stores them in a SQLite DB (mirroring the Entra News DB pattern)
4. Syncs weekly via OpenClaw cron
5. Is queryable by Shadowverse at query time (MCP server or direct SQLite access)

## Architecture

```
YouTube (@merillx)
    │
    ▼
yt-dlp (transcript extraction — --write-auto-subs --skip-download)
    │
    ▼
Python sync script (clean VTT/SRT → plain text → chunk)
    │
    ├──→ FTS5 index (immediate, no external deps)     ─┐
    │                                                    │
    └──→ OpenAI embeddings → sqlite-vec (semantic)    ─┤
                                                       ▼
                              Reciprocal Rank Fusion (RRF) merge
                                                       │
                                                       ▼
                                              MCP Server (search_podcasts)
                                                       │
                                                       ▼
                                    OpenClaw cron (weekly sync — Monday)
```

### Retrieval Strategy — Hybrid FTS5-BM25 + Vector Search

**Why hybrid (not vector-only):**

Podcast transcripts are spoken word, not prose. Auto-subs are messy — no punctuation, garbled proper nouns, phonetic errors. Information density is low (3-4 minutes of actual news in a 30-minute episode, buried in conversational filler). This changes the retrieval calculus:

1. **FTS5-BM25 is primary.** BM25's term-frequency weighting naturally surfaces segments where a topic gets concentrated discussion and down-ranks chit-chat. Exact token matching catches named entities ("PIM for Groups", "SCIM 2.0", "ECMA2Host") that embedding models might smooth over or confuse with semantically adjacent concepts.
2. **Vector search is secondary.** Covers conceptual queries where you don't know the exact terms ("what patterns did he discuss around deprovisioning"). Embeddings catch semantic similarity that keyword search misses.
3. **RRF merges both.** Reciprocal Rank Fusion combines BM25 and vector rankings without needing score calibration. Simple, robust, and adds ~20 lines to the MCP server.
4. **Cold-start resilience.** FTS5 works immediately after transcript insert — no embedding pipeline dependency. If the OpenAI API is down or the key rotates, keyword search on the latest episode still works.
5. **Zero added dependency.** FTS5 is compiled into SQLite 3.46.1. No extension needed for the keyword layer.

### FTS5 Configuration

```sql
CREATE VIRTUAL TABLE chunks_fts USING fts5(
    text,
    section_heading,
    content='chunks',
    content_rowid='id',
    tokenize='porter unicode61'
);
```

- `porter` — handles morphological variants (provision/provisioning, manage/managed)
- `unicode61` — handles international characters

### Query Flow (search_podcasts MCP tool)

```
User query
    │
    ├──→ FTS5 BM25: SELECT ... FROM chunks_fts WHERE chunks_fts MATCH ? ORDER BY bm25(chunks_fts) LIMIT 20
    │
    └──→ sqlite-vec: SELECT ... FROM vec_embeddings JOIN chunks ... ORDER BY vec_distance LIMIT 20
    │
    ▼
Reciprocal Rank Fusion: score = Σ 1/(k + rank_i), k=60
    │
    ▼
Top-K results with episode metadata + timestamps
```

## DB Schema (proposed)

```sql
CREATE TABLE episodes (
    id            INTEGER PRIMARY KEY,
    video_id      TEXT UNIQUE NOT NULL,
    title         TEXT NOT NULL,
    channel       TEXT NOT NULL,
    published_at  TEXT NOT NULL,
    duration_sec  INTEGER,
    url           TEXT NOT NULL,
    transcript_source TEXT NOT NULL,
    ingested_at   TEXT NOT NULL
);

CREATE TABLE chunks (
    id            INTEGER PRIMARY KEY,
    episode_id    INTEGER NOT NULL REFERENCES episodes(id) ON DELETE CASCADE,
    chunk_index   INTEGER NOT NULL,
    start_time    REAL,
    end_time      REAL,
    section_heading TEXT,
    text          TEXT NOT NULL,
    UNIQUE(episode_id, chunk_index)
);

-- FTS5 full-text search index (primary retrieval layer)
CREATE VIRTUAL TABLE chunks_fts USING fts5(
    text,
    section_heading,
    content='chunks',
    content_rowid='id',
    tokenize='porter unicode61'
);

-- Vector embeddings (secondary retrieval layer)
CREATE TABLE vec_embeddings (
    chunk_id     INTEGER PRIMARY KEY REFERENCES chunks(id) ON DELETE CASCADE,
    embedding    BLOB NOT NULL
);

CREATE TABLE tool_mentions (
    id          INTEGER PRIMARY KEY,
    episode_id  INTEGER NOT NULL REFERENCES episodes(id) ON DELETE CASCADE,
    tool_name   TEXT NOT NULL,
    context     TEXT
);

CREATE TABLE meta (
    key   TEXT PRIMARY KEY,
    value TEXT
);

CREATE INDEX idx_episodes_published ON episodes(published_at);
CREATE INDEX idx_chunks_episode ON chunks(episode_id);
```

### FTS5 Triggers (keep index in sync with chunks table)

```sql
CREATE TRIGGER chunks_ai AFTER INSERT ON chunks BEGIN
    INSERT INTO chunks_fts(rowid, text, section_heading)
    VALUES (new.id, new.text, new.section_heading);
END;

CREATE TRIGGER chunks_ad AFTER DELETE ON chunks BEGIN
    INSERT INTO chunks_fts(chunks_fts, rowid, text, section_heading)
    VALUES ('delete', old.id, old.text, old.section_heading);
END;

CREATE TRIGGER chunks_au AFTER UPDATE ON chunks BEGIN
    INSERT INTO chunks_fts(chunks_fts, rowid, text, section_heading)
    VALUES ('delete', old.id, old.text, old.section_heading);
    INSERT INTO chunks_fts(rowid, text, section_heading)
    VALUES (new.id, new.text, new.section_heading);
END;
```

## Component Breakdown

### 1. Sync Script — `sync-entra-podcasts.py`

**Location:** `~/.openclaw/wiki/main/.data/`

**Flow:**
1. Use `yt-dlp` to list channel uploads since last sync (`--dateafter now-7days`)
2. For each new video, download auto-subs (`--write-auto-subs --sub-lang en --skip-download`)
3. Parse VTT/SRT → clean plain text with timestamp markers
4. Chunk by topic/segment (chapter-aware if chapters exist, else fixed-window ~60-90 seconds)
5. Insert chunks into SQLite — FTS5 index auto-populates via triggers (immediate search available)
6. Generate embeddings (OpenAI `text-embedding-3-small`) and insert into `vec_embeddings`
7. Track sync state in `meta` table (last sync date, last video ID)

**Key ordering note:** Steps 5 and 6 are decoupled. FTS5 search works immediately after step 5. Embeddings (step 6) can fail or be delayed without blocking search availability.

**Dependencies to install:**
- `yt-dlp` (`pip3 install yt-dlp`)
- `sqlite-vec` (`pip3 install sqlite-vec`) — only needed for vector/semantic layer
- `openai` Python package (for embeddings) — only needed for vector/semantic layer

### 2. MCP Server — `entra-podcasts-mcp.py`

**Pattern:** Mirror EntraNewsMCPServer architecture (Python, stdio transport)

**Tools exposed:**
- `search_podcasts` — **hybrid retrieval**: FTS5 BM25 + sqlite-vec vector search, merged via Reciprocal Rank Fusion (k=60). Returns ranked chunks with episode metadata, timestamps, and relevance scores from both paths.
- `search_podcasts_fts` — FTS5-only keyword search (fast, no embedding dependency — useful when OpenAI API is unavailable or for exact entity lookups)
- `search_podcasts_semantic` — vector-only semantic search (for conceptual queries where exact terms are unknown)
- `get_episode` — fetch full transcript for a specific episode (by video_id or episode number)
- `list_episodes` — list available episodes with metadata
- `get_tool_mentions` — tools/products mentioned across episodes

**RRF Implementation (in MCP server):**

```python
def rrf_merge(fts_results, vec_results, k=60, top_n=20):
    """Reciprocal Rank Fusion: score = Σ 1/(k + rank_i)"""
    scores = {}
    for rank, row in enumerate(fts_results):
        scores[row['chunk_id']] = scores.get(row['chunk_id'], 0) + 1 / (k + rank)
    for rank, row in enumerate(vec_results):
        scores[row['chunk_id']] = scores.get(row['chunk_id'], 0) + 1 / (k + rank)
    return sorted(scores.items(), key=lambda x: -x[1])[:top_n]
```

### 3. Cron Job — Weekly Sync

**Schedule:** `30 12 * * 1` (12:30 PM Monday, Australia/Sydney — 30 min after Entra News sync)
**Session target:** isolated agent turn
**Delivery:** announce to Telegram (Shadowverse bot)
**Timeout:** 300 seconds

### 4. OpenClaw MCP Configuration

```json
{
  "mcp": {
    "servers": {
      "entra-podcasts": {
        "transport": "stdio",
        "command": "python3",
        "args": ["/home/marvin/.openclaw/wiki/main/.data/entra-podcasts-mcp.py"]
      }
    }
  }
}
```

## Environment Status (as of 2026-07-16)

| Component | Status |
|-----------|--------|
| sqlite3 | ✅ Installed (3.46.1) — includes FTS5 support |
| ffmpeg | ✅ Installed (8.0.1) |
| yt-dlp | ❌ Not installed — `pip3 install yt-dlp` |
| sqlite-vec | ❌ Not installed — `pip3 install sqlite-vec` (only needed for vector layer) |
| openai Python | ❓ Needs check (only needed for vector layer) |
| FTS5 | ✅ Built into SQLite 3.46.1 — no install required |
| entra-news.db | ✅ Present (18MB, 229 issues) — reference pattern |

## Build Phases

| Phase | Task | Est. Effort | Search Available |
|-------|------|-------------|----------------|
| **1** | Install dependencies (yt-dlp, sqlite-vec, openai) | 5 min | — |
| **2** | Write sync script — test single video, then full channel backfill | 2-3 hrs | FTS5 after first transcript |
| **3** | DB creation + initial backfill + verify FTS5 search | 1 hr | FTS5 ✅ |
| **4** | Generate embeddings for backfilled chunks + verify vector search | 30 min | Hybrid ✅ |
| **5** | MCP server — write, expose tools (hybrid search + RRF), test locally | 1-2 hrs | Hybrid ✅ |
| **6** | OpenClaw integration — config, cron, TOOLS.md, end-to-end test | 30 min | Hybrid ✅ |

**Note:** Phases 3 and 4 are now split. FTS5 search is available after Phase 3 (no embedding dependency). Vector search comes online after Phase 4. This means Shadowverse can query podcast content earlier in the build, and the initial backfill can validate search quality before spending on embeddings.

## Attribution Convention

| Prefix | Meaning |
|--------|---------|
| 🎙️ *From Entra News Podcast #[N]: [title]* | Merill's YouTube episode |
| 🎙️ *From Entra News Podcast, [timestamp]* | Specific timestamp reference |

## Relationship to Existing Layers

| Layer | Source | Format | DB |
|-------|--------|--------|-----|
| 🧠 Layer 1 — Compiled knowledge | Wiki vault | Blog posts, code | Wiki files |
| 📰 Layer 2a — Written intelligence | Entra News DB | Newsletter issues | `entra-news.db` |
| 🎙️ Layer 2b — Audio intelligence | Entra News Podcasts | YouTube transcripts | `entra-podcasts.db` *(NEW)* |
| 📖 Layer 3 — Live official docs | Microsoft Learn MCP | Real-time docs | Remote API |

## Risks & Considerations

- **Transcript quality:** YouTube auto-subs are decent but not perfect. FTS5 `porter` tokenizer helps with morphological variants. May add a cleanup pass for common mis-transcriptions of identity terms (e.g. "Entra ID" → "entra eye dee").
- **Channel scope:** Merill's channel may have non-Entra content. Filter by title/description or playlist.
- **Rate limits:** YouTube may throttle yt-dlp. Add backoff/retry.
- **Embedding cost:** OpenAI text-embedding-3-small is cheap (~$0.02/1M tokens). Backfill could cost a few dollars. Acceptable — and now optional for initial search availability.
- **DB size:** Transcripts are smaller than newsletter chunks. Expect ~5-10MB for full backfill. FTS5 index adds ~30-50% overhead on text size.
- **sqlite-vec compatibility:** Verify it loads cleanly with SQLite 3.46.1. Not a blocker — FTS5 works without it.
- **FTS5 index growth:** Triggers keep the FTS5 index in sync automatically. For the backfill, bulk insert is fine — triggers fire per row. For very large initial loads, consider `INSERT INTO chunks_fts(chunks_fts) VALUES('rebuild')` after bulk insert.
- **RRF k parameter:** k=60 is the standard default from the original RRF paper. May need tuning based on result quality during testing.

## Source References

- ✍️ Entra News DB sync script: `~/.openclaw/wiki/main/.data/sync-entra-news.sh`
- 💻 EntraNewsMCPServer: https://github.com/darrenjrobinson/EntraNewsMCPServer
- 📖 sqlite-vec: https://sqlite.org/vec1
- 📖 SQLite FTS5: https://www.sqlite.org/fts5.html
- 📖 SQLite FTS5 BM25: https://www.sqlite.org/fts5.html#the_bm25_function
- 📖 yt-dlp transcript extraction: `--write-auto-subs --sub-lang en --skip-download`
- 📖 Reciprocal Rank Fusion: Cormack et al., "Reciprocal Rank Fusion outperforms Condorcet and individual rank learning methods" (2009)

---

*Filed 2026-07-16. Revised 2026-07-16 — hybrid FTS5-BM25 + vector retrieval. Ready for build when Doc gives the go-ahead.*
