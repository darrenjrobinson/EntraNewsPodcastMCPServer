#!/usr/bin/env ts-node
/**
 * Entra.Chat podcast ingestion pipeline
 *
 * Lists the Entra.Chat playlist with yt-dlp, downloads captions per video
 * (json3 preferred), chunks the transcripts chapter-aware with timestamps,
 * generates OpenAI embeddings, extracts guests and tool mentions, and stores
 * everything in a local SQLite database.
 *
 * Usage:
 *   node dist/scripts/ingest.js                    # Full ingest (all playlist videos)
 *   node dist/scripts/ingest.js --incremental      # Only videos not yet in the DB
 *   node dist/scripts/ingest.js --video <id>       # Single video (re-ingests if present)
 *   node dist/scripts/ingest.js --limit 2          # First N playlist videos (testing)
 *   node dist/scripts/ingest.js --reextract        # Re-run guest + tool-mention extraction
 *                                                  # from stored data (no network) — use after
 *                                                  # editing guest-overrides.json or known-tools.ts
 *   node dist/scripts/ingest.js --embed-missing    # Generate embeddings for chunks that have
 *                                                  # none (requires OPENAI_API_KEY; no YouTube
 *                                                  # access) — use after a keyless ingest
 *
 * Requires the yt-dlp binary on PATH (pipx install yt-dlp / winget install yt-dlp).
 *
 * Environment variables:
 *   OPENAI_API_KEY   — optional; embeddings are skipped with a warning when absent
 *                      (BM25 keyword search still works — PRD cold-start requirement)
 *   INGEST_DB_PATH   — output SQLite path (default: ./entra-news-podcasts.db)
 */

import { DatabaseSync } from 'node:sqlite';
import * as https from 'https';
import * as fs from 'fs';
import * as path from 'path';

import {
  listPlaylist,
  fetchVideo,
  cleanupVideoFiles,
  ytDlpVersion,
  BotBlockedError,
  VideoFetchResult,
} from './lib/ytdlp.js';
import {
  parseJson3,
  parseVtt,
  chunkTranscript,
  buildFullTranscript,
  TimedWord,
  ChunkData,
} from './lib/transcript.js';
import { extractGuests, normalizeGuestName, GuestData, GuestOverrides } from './lib/guests.js';
import { KNOWN_TOOLS } from './lib/known-tools.js';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const PLAYLIST_ID = 'PL06Jj3_onEzEBGRfA7Zddg1IrjgpU1eGp';
const PLAYLIST_URL = `https://www.youtube.com/playlist?list=${PLAYLIST_ID}`;
const OPENAI_MODEL = 'text-embedding-3-small';
const EMBEDDING_DIMENSIONS = 1536;
const EMBEDDING_BATCH = 20; // items per OpenAI request
const RATE_LIMIT_DELAY_MS = 200;
// Jittered pause between video downloads, on top of yt-dlp's own --sleep-* flags
const VIDEO_SLEEP_BASE_MS = 4000;
const VIDEO_SLEEP_JITTER_MS = 3000;

const DB_PATH =
  process.env.INGEST_DB_PATH ?? path.join(process.cwd(), 'entra-news-podcasts.db');
const TMP_DIR = path.join(process.cwd(), 'yt-tmp');

const args = process.argv.slice(2);
const INCREMENTAL = args.includes('--incremental');
const SINGLE_VIDEO_ARG = (() => {
  const idx = args.indexOf('--video');
  return idx >= 0 ? args[idx + 1] : null;
})();
const LIMIT_ARG = (() => {
  const idx = args.indexOf('--limit');
  return idx >= 0 ? parseInt(args[idx + 1], 10) : null;
})();
const REEXTRACT = args.includes('--reextract') || args.includes('--reextract-guests');
const EMBED_MISSING = args.includes('--embed-missing');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function log(msg: string): void {
  process.stdout.write(`[ingest] ${msg}\n`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function inferEpisodeNumber(title: string): number | null {
  const hash = title.match(/#(\d+)\b/);
  if (hash) return parseInt(hash[1], 10);
  const ep = title.match(/\b(?:episode|ep\.?)\s*(\d+)\b/i);
  if (ep) return parseInt(ep[1], 10);
  return null;
}

/** yt-dlp upload_date "YYYYMMDD" → "YYYY-MM-DD" */
function formatUploadDate(uploadDate: string): string {
  return `${uploadDate.slice(0, 4)}-${uploadDate.slice(4, 6)}-${uploadDate.slice(6, 8)}`;
}

function loadGuestOverrides(): GuestOverrides {
  // Compiled layout is dist/scripts/ingest.js — the JSON stays in scripts/lib/
  const candidates = [
    path.join(__dirname, 'lib', 'guest-overrides.json'),
    path.join(__dirname, '..', '..', 'scripts', 'lib', 'guest-overrides.json'),
  ];
  for (const overridesPath of candidates) {
    try {
      const raw = JSON.parse(fs.readFileSync(overridesPath, 'utf-8')) as Record<string, unknown>;
      const overrides: GuestOverrides = {};
      for (const [key, value] of Object.entries(raw)) {
        // Skip the documentation key only — YouTube video IDs can start with '_'
        if (key !== '_comment') overrides[key] = value as GuestOverrides[string];
      }
      return overrides;
    } catch {
      // try next path
    }
  }
  return {};
}

// ---------------------------------------------------------------------------
// OpenAI embeddings
// ---------------------------------------------------------------------------
async function embedBatch(texts: string[], apiKey: string): Promise<Float32Array[]> {
  const body = JSON.stringify({
    input: texts,
    model: OPENAI_MODEL,
    dimensions: EMBEDDING_DIMENSIONS,
  });

  const responseText = await new Promise<string>((resolve, reject) => {
    const req = https.request(
      'https://api.openai.com/v1/embeddings',
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
        },
      },
      (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => resolve(data));
        res.on('error', reject);
      }
    );
    req.on('error', reject);
    req.write(body);
    req.end();
  });

  const parsed = JSON.parse(responseText) as {
    data: Array<{ embedding: number[]; index: number }>;
    error?: { message: string };
  };

  if (parsed.error) throw new Error(`OpenAI error: ${parsed.error.message}`);

  const sorted = [...parsed.data].sort((a, b) => a.index - b.index);
  return sorted.map((d) => new Float32Array(d.embedding));
}

// ---------------------------------------------------------------------------
// Database
// ---------------------------------------------------------------------------
function initSchema(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS episodes (
      id                INTEGER PRIMARY KEY,
      video_id          TEXT    UNIQUE NOT NULL,
      episode_number    INTEGER,
      title             TEXT    NOT NULL,
      channel           TEXT    NOT NULL,
      published_at      TEXT    NOT NULL,
      duration_sec      INTEGER,
      url               TEXT    NOT NULL,
      description       TEXT,
      has_chapters      INTEGER NOT NULL DEFAULT 0,
      transcript_source TEXT    NOT NULL,
      transcript        TEXT,
      ingested_at       TEXT    NOT NULL
    );

    CREATE TABLE IF NOT EXISTS chunks (
      id              INTEGER PRIMARY KEY,
      episode_id      INTEGER NOT NULL REFERENCES episodes(id) ON DELETE CASCADE,
      chunk_index     INTEGER NOT NULL,
      start_time      REAL,
      end_time        REAL,
      section_heading TEXT,
      text            TEXT    NOT NULL,
      UNIQUE(episode_id, chunk_index)
    );

    CREATE TABLE IF NOT EXISTS vec_embeddings (
      chunk_id  INTEGER PRIMARY KEY REFERENCES chunks(id) ON DELETE CASCADE,
      embedding BLOB NOT NULL
    );

    CREATE TABLE IF NOT EXISTS guests (
      id              INTEGER PRIMARY KEY,
      name            TEXT NOT NULL,
      normalized_name TEXT UNIQUE NOT NULL,
      linkedin_url    TEXT,
      twitter_url     TEXT,
      github_url      TEXT,
      bluesky_url     TEXT,
      website_url     TEXT,
      bio             TEXT
    );

    CREATE TABLE IF NOT EXISTS episode_guests (
      episode_id INTEGER NOT NULL REFERENCES episodes(id) ON DELETE CASCADE,
      guest_id   INTEGER NOT NULL REFERENCES guests(id) ON DELETE CASCADE,
      PRIMARY KEY (episode_id, guest_id)
    );

    CREATE TABLE IF NOT EXISTS tool_mentions (
      id         INTEGER PRIMARY KEY,
      episode_id INTEGER NOT NULL REFERENCES episodes(id) ON DELETE CASCADE,
      tool_name  TEXT    NOT NULL,
      context    TEXT,
      start_time REAL,
      UNIQUE(episode_id, tool_name)
    );

    CREATE TABLE IF NOT EXISTS meta (
      key   TEXT PRIMARY KEY,
      value TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_episodes_published ON episodes(published_at);
    CREATE INDEX IF NOT EXISTS idx_episodes_number    ON episodes(episode_number);
    CREATE INDEX IF NOT EXISTS idx_chunks_episode     ON chunks(episode_id);
    CREATE INDEX IF NOT EXISTS idx_tools_episode      ON tool_mentions(episode_id);
    CREATE INDEX IF NOT EXISTS idx_episode_guests_guest ON episode_guests(guest_id);
  `);
}

function getKnownVideoIds(db: DatabaseSync): Set<string> {
  const rows = db.prepare('SELECT video_id FROM episodes').all() as Array<{ video_id: string }>;
  return new Set(rows.map((r) => r.video_id));
}

function upsertEpisode(
  db: DatabaseSync,
  fetched: VideoFetchResult,
  episodeNumber: number | null,
  transcript: string
): number {
  const { info, transcriptSource } = fetched;
  db.prepare(
    `INSERT INTO episodes (video_id, episode_number, title, channel, published_at,
                           duration_sec, url, description, has_chapters,
                           transcript_source, transcript, ingested_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(video_id) DO UPDATE SET
       episode_number    = excluded.episode_number,
       title             = excluded.title,
       channel           = excluded.channel,
       published_at      = excluded.published_at,
       duration_sec      = excluded.duration_sec,
       url               = excluded.url,
       description       = excluded.description,
       has_chapters      = excluded.has_chapters,
       transcript_source = excluded.transcript_source,
       transcript        = excluded.transcript,
       ingested_at       = excluded.ingested_at`
  ).run(
    info.id,
    episodeNumber,
    info.title,
    info.channel ?? 'Merill Fernando',
    formatUploadDate(info.upload_date),
    info.duration ?? null,
    info.webpage_url ?? `https://www.youtube.com/watch?v=${info.id}`,
    info.description ?? null,
    info.chapters && info.chapters.length > 0 ? 1 : 0,
    transcriptSource ?? 'auto',
    transcript,
    new Date().toISOString()
  );
  const row = db.prepare('SELECT id FROM episodes WHERE video_id = ?').get(info.id) as { id: number };
  return row.id;
}

/** Remove all derived rows for an episode so re-ingestion is idempotent. */
function clearEpisodeDerived(db: DatabaseSync, episodeId: number): void {
  db.prepare(
    'DELETE FROM vec_embeddings WHERE chunk_id IN (SELECT id FROM chunks WHERE episode_id = ?)'
  ).run(episodeId);
  db.prepare('DELETE FROM chunks WHERE episode_id = ?').run(episodeId);
  db.prepare('DELETE FROM tool_mentions WHERE episode_id = ?').run(episodeId);
  db.prepare('DELETE FROM episode_guests WHERE episode_id = ?').run(episodeId);
}

function insertChunks(db: DatabaseSync, episodeId: number, chunks: ChunkData[]): number[] {
  const stmt = db.prepare(
    `INSERT INTO chunks (episode_id, chunk_index, start_time, end_time, section_heading, text)
     VALUES (?, ?, ?, ?, ?, ?)`
  );
  const ids: number[] = [];
  chunks.forEach((c, i) => {
    const result = stmt.run(episodeId, i, c.start_time, c.end_time, c.section_heading, c.text);
    ids.push(Number((result as { lastInsertRowid: number | bigint }).lastInsertRowid));
  });
  return ids;
}

function insertEmbedding(db: DatabaseSync, chunkId: number, embedding: Float32Array): void {
  const buf = Buffer.from(embedding.buffer);
  db.prepare(
    `INSERT OR REPLACE INTO vec_embeddings (chunk_id, embedding) VALUES (?, ?)`
  ).run(chunkId, buf);
}

/**
 * Upsert a guest by normalised name. On returning guests, newest non-null
 * profile links win so later episodes fill in gaps from earlier ones.
 */
function upsertGuest(db: DatabaseSync, guest: GuestData): number {
  const normalized = normalizeGuestName(guest.name);
  const existing = db
    .prepare('SELECT id FROM guests WHERE normalized_name = ?')
    .get(normalized) as { id: number } | undefined;

  if (existing) {
    db.prepare(
      `UPDATE guests SET
         name         = ?,
         linkedin_url = COALESCE(?, linkedin_url),
         twitter_url  = COALESCE(?, twitter_url),
         github_url   = COALESCE(?, github_url),
         bluesky_url  = COALESCE(?, bluesky_url),
         website_url  = COALESCE(?, website_url),
         bio          = COALESCE(?, bio)
       WHERE id = ?`
    ).run(
      guest.name,
      guest.linkedin_url,
      guest.twitter_url,
      guest.github_url,
      guest.bluesky_url,
      guest.website_url,
      guest.bio,
      existing.id
    );
    return existing.id;
  }

  const result = db
    .prepare(
      `INSERT INTO guests (name, normalized_name, linkedin_url, twitter_url, github_url,
                           bluesky_url, website_url, bio)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      guest.name,
      normalized,
      guest.linkedin_url,
      guest.twitter_url,
      guest.github_url,
      guest.bluesky_url,
      guest.website_url,
      guest.bio
    );
  return Number((result as { lastInsertRowid: number | bigint }).lastInsertRowid);
}

function linkEpisodeGuest(db: DatabaseSync, episodeId: number, guestId: number): void {
  db.prepare(
    'INSERT OR IGNORE INTO episode_guests (episode_id, guest_id) VALUES (?, ?)'
  ).run(episodeId, guestId);
}

/** Match chunks against the curated tool list; first hit per tool per episode. */
function extractAndInsertToolMentions(
  db: DatabaseSync,
  episodeId: number,
  chunks: ChunkData[]
): number {
  const stmt = db.prepare(
    `INSERT OR IGNORE INTO tool_mentions (episode_id, tool_name, context, start_time)
     VALUES (?, ?, ?, ?)`
  );

  let count = 0;
  for (const tool of KNOWN_TOOLS) {
    const pattern = tool.aliases
      .map((a) => a.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
      .join('|');
    const re = new RegExp(`\\b(?:${pattern})\\b`, 'i');

    for (const chunk of chunks) {
      const m = re.exec(chunk.text);
      if (!m) continue;

      const start = Math.max(0, m.index - 150);
      const end = Math.min(chunk.text.length, m.index + m[0].length + 150);
      const context = '...' + chunk.text.slice(start, end).replace(/\s+/g, ' ').trim() + '...';

      const result = stmt.run(episodeId, tool.name, context.slice(0, 500), chunk.start_time);
      if ((result as { changes: number | bigint }).changes) count++;
      break; // first mention per tool per episode
    }
  }
  return count;
}

function updateMeta(db: DatabaseSync): void {
  const episodeCount = (db.prepare('SELECT COUNT(*) AS n FROM episodes').get() as { n: number }).n;
  const chunkCount = (db.prepare('SELECT COUNT(*) AS n FROM chunks').get() as { n: number }).n;
  const guestCount = (db.prepare('SELECT COUNT(*) AS n FROM guests').get() as { n: number }).n;
  const upsert = db.prepare(`INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)`);
  upsert.run('last_updated', new Date().toISOString());
  upsert.run('episode_count', String(episodeCount));
  upsert.run('chunk_count', String(chunkCount));
  upsert.run('guest_count', String(guestCount));
  upsert.run('playlist_id', PLAYLIST_ID);
  upsert.run('schema_version', '1');
}

/**
 * Re-run guest and tool-mention extraction over episodes already in the DB
 * using stored titles/descriptions/chunks — no network calls. Use after
 * editing guest-overrides.json or known-tools.ts.
 */
function reextractDerived(db: DatabaseSync): void {
  const overrides = loadGuestOverrides();
  const episodes = db
    .prepare('SELECT id, video_id, title, description FROM episodes ORDER BY published_at')
    .all() as Array<{ id: number; video_id: string; title: string; description: string | null }>;

  const noGuests: string[] = [];
  let linked = 0;
  let toolMentions = 0;

  db.exec('BEGIN');
  try {
    db.prepare('DELETE FROM episode_guests').run();
    db.prepare('DELETE FROM guests').run();
    db.prepare('DELETE FROM tool_mentions').run();

    for (const ep of episodes) {
      const guests = extractGuests(ep.video_id, ep.title, ep.description, overrides);
      if (guests.length === 0) {
        noGuests.push(`${ep.video_id} "${ep.title}"`);
      }
      for (const guest of guests) {
        const guestId = upsertGuest(db, guest);
        linkEpisodeGuest(db, ep.id, guestId);
        linked++;
      }

      const chunks = db
        .prepare('SELECT text, start_time, end_time, section_heading FROM chunks WHERE episode_id = ? ORDER BY chunk_index')
        .all(ep.id) as unknown as ChunkData[];
      toolMentions += extractAndInsertToolMentions(db, ep.id, chunks);
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }

  updateMeta(db);
  log(`Re-extracted across ${episodes.length} episode(s): ${linked} guest link(s), ${toolMentions} tool mention(s).`);
  if (noGuests.length > 0) {
    log(`⚠ No guest extracted for ${noGuests.length} video(s) — review and add to scripts/lib/guest-overrides.json:`);
    for (const v of noGuests) log(`    ${v}`);
  }
}

/** Embed chunks that have no embedding yet — no YouTube access required. */
async function embedMissing(db: DatabaseSync, apiKey: string): Promise<void> {
  const missing = db
    .prepare(
      'SELECT id, text FROM chunks WHERE id NOT IN (SELECT chunk_id FROM vec_embeddings) ORDER BY id'
    )
    .all() as Array<{ id: number; text: string }>;

  if (missing.length === 0) {
    log('All chunks already have embeddings.');
    return;
  }
  log(`Embedding ${missing.length} chunk(s) without embeddings…`);

  for (let b = 0; b < missing.length; b += EMBEDDING_BATCH) {
    const batch = missing.slice(b, b + EMBEDDING_BATCH);
    const embeddings = await embedBatch(batch.map((c) => c.text), apiKey);
    db.exec('BEGIN');
    try {
      batch.forEach((chunk, i) => insertEmbedding(db, chunk.id, embeddings[i]));
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
    if (b % (EMBEDDING_BATCH * 10) === 0) {
      log(`  ${Math.min(b + EMBEDDING_BATCH, missing.length)}/${missing.length}`);
    }
    await sleep(RATE_LIMIT_DELAY_MS);
  }

  updateMeta(db);
  log(`Done. Embedded ${missing.length} chunk(s).`);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main(): Promise<void> {
  if (EMBED_MISSING) {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) throw new Error('--embed-missing requires OPENAI_API_KEY.');
    log(`Database path: ${DB_PATH}`);
    const db = new DatabaseSync(DB_PATH);
    initSchema(db);
    await embedMissing(db, apiKey);
    db.close();
    return;
  }

  if (REEXTRACT) {
    log(`Database path: ${DB_PATH}`);
    const db = new DatabaseSync(DB_PATH);
    initSchema(db);
    reextractDerived(db);
    db.close();
    return;
  }

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    log('⚠ OPENAI_API_KEY not set — embeddings will be SKIPPED (keyword/BM25 search still works).');
  }

  const version = await ytDlpVersion().catch(() => null);
  if (!version) {
    throw new Error('yt-dlp not found on PATH. Install it: pipx install yt-dlp (or winget install yt-dlp).');
  }
  log(`yt-dlp ${version}`);
  log(`Database path: ${DB_PATH}`);
  log(`Mode: ${SINGLE_VIDEO_ARG ? `single video ${SINGLE_VIDEO_ARG}` : INCREMENTAL ? 'incremental' : 'full'}${LIMIT_ARG ? ` (limit ${LIMIT_ARG})` : ''}`);

  const db = new DatabaseSync(DB_PATH);
  initSchema(db);
  const overrides = loadGuestOverrides();
  const known = getKnownVideoIds(db);
  log(`Known episodes in DB: ${known.size}`);

  // ---- Decide which videos to process --------------------------------------
  let targets: Array<{ video_id: string; title: string }>;

  if (SINGLE_VIDEO_ARG) {
    targets = [{ video_id: SINGLE_VIDEO_ARG, title: '(direct)' }];
  } else {
    log('Listing playlist…');
    const playlist = await listPlaylist(PLAYLIST_URL);
    log(`Playlist videos: ${playlist.length}`);

    targets = INCREMENTAL ? playlist.filter((p) => !known.has(p.video_id)) : playlist;
    if (INCREMENTAL) log(`New videos to ingest: ${targets.length}`);
    if (LIMIT_ARG != null) targets = targets.slice(0, LIMIT_ARG);
  }

  if (targets.length === 0) {
    log('Nothing to ingest. Database is up to date.');
    updateMeta(db);
    db.close();
    return;
  }

  // ---- Process each video ---------------------------------------------------
  let totalChunks = 0;
  let embeddedChunks = 0;
  const noTranscript: string[] = [];
  const noGuests: string[] = [];

  for (let vi = 0; vi < targets.length; vi++) {
    const target = targets[vi];
    log(`[${vi + 1}/${targets.length}] ${target.video_id} "${target.title}"`);

    let fetched: VideoFetchResult;
    try {
      fetched = await fetchVideo(target.video_id, TMP_DIR);
    } catch (err) {
      if (err instanceof BotBlockedError) throw err; // abort the whole run loudly
      log(`  ⚠ Failed to fetch video: ${err instanceof Error ? err.message : err}`);
      continue;
    }

    try {
      if (!fetched.captionPath) {
        log('  ⚠ No captions available (very new upload?) — skipping.');
        noTranscript.push(target.video_id);
        continue;
      }

      // Parse captions → timed words
      const raw = fs.readFileSync(fetched.captionPath, 'utf-8');
      const words: TimedWord[] =
        fetched.captionFormat === 'json3' ? parseJson3(raw) : parseVtt(raw);
      if (words.length === 0) {
        log('  ⚠ Empty transcript — skipping.');
        noTranscript.push(target.video_id);
        continue;
      }

      const chunks = chunkTranscript(words, fetched.info.chapters);
      const transcript = buildFullTranscript(words);
      const episodeNumber = inferEpisodeNumber(fetched.info.title);
      log(`  → ${words.length} words, ${chunks.length} chunks (${fetched.transcriptSource} captions, ${fetched.info.chapters?.length ?? 0} chapters)`);

      // Embed (optional — skipped without an API key)
      const embeddings: Float32Array[] = [];
      if (apiKey) {
        const texts = chunks.map((c) => c.text);
        for (let b = 0; b < texts.length; b += EMBEDDING_BATCH) {
          const batch = texts.slice(b, b + EMBEDDING_BATCH);
          const batchEmbeddings = await embedBatch(batch, apiKey);
          embeddings.push(...batchEmbeddings);
          await sleep(RATE_LIMIT_DELAY_MS);
        }
      }

      // Guests
      const guests = extractGuests(
        target.video_id,
        fetched.info.title,
        fetched.info.description,
        overrides
      );
      if (guests.length === 0) noGuests.push(`${target.video_id} "${fetched.info.title}"`);

      // Store everything for this episode in one transaction
      db.exec('BEGIN');
      try {
        const episodeId = upsertEpisode(db, fetched, episodeNumber, transcript);
        clearEpisodeDerived(db, episodeId);

        const chunkIds = insertChunks(db, episodeId, chunks);
        embeddings.forEach((e, i) => insertEmbedding(db, chunkIds[i], e));

        for (const guest of guests) {
          const guestId = upsertGuest(db, guest);
          linkEpisodeGuest(db, episodeId, guestId);
        }

        const toolCount = extractAndInsertToolMentions(db, episodeId, chunks);
        db.exec('COMMIT');

        totalChunks += chunks.length;
        embeddedChunks += embeddings.length;
        log(
          `  → stored: ${chunks.length} chunks, ${embeddings.length} embeddings, ` +
            `${guests.length} guest(s)${guests.length ? ` [${guests.map((g) => g.name).join(', ')}]` : ''}, ${toolCount} tool mention(s)`
        );
      } catch (err) {
        db.exec('ROLLBACK');
        throw err;
      }
    } finally {
      cleanupVideoFiles(target.video_id, TMP_DIR);
    }

    if (vi < targets.length - 1) {
      await sleep(VIDEO_SLEEP_BASE_MS + Math.random() * VIDEO_SLEEP_JITTER_MS);
    }
  }

  updateMeta(db);

  log(`Done. Processed ${targets.length} video(s), ${totalChunks} chunks (${embeddedChunks} embedded).`);
  if (noTranscript.length > 0) {
    log(`⚠ No transcript for ${noTranscript.length} video(s): ${noTranscript.join(', ')}`);
  }
  if (noGuests.length > 0) {
    log(`⚠ No guest extracted for ${noGuests.length} video(s) — review and add to scripts/lib/guest-overrides.json:`);
    for (const v of noGuests) log(`    ${v}`);
  }
  log(`Database saved to: ${DB_PATH}`);

  db.close();
}

main().catch((err) => {
  process.stderr.write(`Ingestion failed: ${err instanceof Error ? err.message : err}\n`);
  process.exit(1);
});
