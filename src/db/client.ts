import { DatabaseSync } from 'node:sqlite';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as https from 'https';
import * as http from 'http';

import { Bm25Index } from './bm25.js';

const GITHUB_REPO = 'darrenjrobinson/EntraNewsPodcastMCPServer';
const DB_FILENAME = 'entra-news-podcasts.db';
const META_FILENAME = 'release-meta.json';
const CACHE_DIR = path.join(os.homedir(), '.entra-news-podcast-mcp');
const DB_PATH = path.join(CACHE_DIR, DB_FILENAME);
const META_PATH = path.join(CACHE_DIR, META_FILENAME);

export interface SearchResult {
  chunk_id: number;
  text: string;
  section_heading: string | null;
  start_time: number | null;
  video_id: string;
  episode_number: number | null;
  title: string;
  published_at: string;
  url: string;
  guests: string | null; // comma-separated guest names
  distance: number;
}

export interface Episode {
  id: number;
  video_id: string;
  episode_number: number | null;
  title: string;
  channel: string;
  published_at: string;
  duration_sec: number | null;
  url: string;
  description: string | null;
  has_chapters: number;
  transcript_source: string;
  transcript: string | null;
  ingested_at: string;
}

export interface Guest {
  id: number;
  name: string;
  linkedin_url: string | null;
  twitter_url: string | null;
  github_url: string | null;
  bluesky_url: string | null;
  website_url: string | null;
  bio: string | null;
}

export interface GuestSummary extends Guest {
  episode_count: number;
  latest_appearance: string | null;
}

export interface Chapter {
  section_heading: string;
  start_time: number | null;
}

export interface ToolMention {
  id: number;
  episode_id: number;
  episode_number: number | null;
  episode_title: string;
  video_id: string;
  published_at: string;
  episode_url: string;
  tool_name: string;
  context: string | null;
  start_time: number | null;
}

interface ReleaseMeta {
  tag: string;
  published_at: string;
  asset_url: string;
  checked_at: string;
}

// ---------------------------------------------------------------------------
// In-memory search indexes: embeddings (vector) + BM25 (keyword)
// ---------------------------------------------------------------------------
interface EmbeddingEntry {
  chunk_id: number;
  embedding: Float32Array;
  norm: number;
}

let db: DatabaseSync | null = null;
let embeddingCache: EmbeddingEntry[] = [];
const bm25 = new Bm25Index();

function vecNorm(v: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < v.length; i++) sum += v[i] * v[i];
  return Math.sqrt(sum);
}

function cosineSimilarity(
  a: Float32Array, aNorm: number,
  b: Float32Array, bNorm: number
): number {
  if (aNorm === 0 || bNorm === 0) return 0;
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
  return dot / (aNorm * bNorm);
}

function fetchJson(url: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const client = url.startsWith('https') ? https : http;
    const options = {
      headers: {
        'User-Agent': 'entra-news-podcast-mcp/0.1.0',
        Accept: 'application/json',
      },
    };
    client.get(url, options, (res) => {
      if (res.statusCode === 302 || res.statusCode === 301) {
        if (res.headers.location) {
          resolve(fetchJson(res.headers.location));
          return;
        }
      }
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          reject(new Error(`Failed to parse JSON from ${url}: ${e}`));
        }
      });
      res.on('error', reject);
    }).on('error', reject);
  });
}

function downloadFile(url: string, dest: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const client = url.startsWith('https') ? https : http;
    const options = {
      headers: { 'User-Agent': 'entra-news-podcast-mcp/0.1.0' },
    };
    const file = fs.createWriteStream(dest + '.tmp');
    const request = client.get(url, options, (res) => {
      if (res.statusCode === 302 || res.statusCode === 301) {
        file.close();
        fs.unlinkSync(dest + '.tmp');
        if (res.headers.location) {
          downloadFile(res.headers.location, dest).then(resolve).catch(reject);
          return;
        }
      }
      res.pipe(file);
      file.on('finish', () => {
        file.close(() => {
          fs.renameSync(dest + '.tmp', dest);
          resolve();
        });
      });
    });
    request.on('error', (err) => {
      file.close();
      fs.unlink(dest + '.tmp', () => {});
      reject(err);
    });
    file.on('error', (err) => {
      file.close();
      fs.unlink(dest + '.tmp', () => {});
      reject(err);
    });
  });
}

async function getLatestRelease(): Promise<ReleaseMeta | null> {
  try {
    const apiUrl = `https://api.github.com/repos/${GITHUB_REPO}/releases/latest`;
    const release = (await fetchJson(apiUrl)) as {
      tag_name: string;
      published_at: string;
      assets: Array<{ name: string; browser_download_url: string }>;
    };

    const dbAsset = release.assets?.find((a) => a.name === DB_FILENAME);
    if (!dbAsset) return null;

    return {
      tag: release.tag_name,
      published_at: release.published_at,
      asset_url: dbAsset.browser_download_url,
      checked_at: new Date().toISOString(),
    };
  } catch {
    return null;
  }
}

function loadCachedMeta(): ReleaseMeta | null {
  try {
    if (!fs.existsSync(META_PATH)) return null;
    return JSON.parse(fs.readFileSync(META_PATH, 'utf-8')) as ReleaseMeta;
  } catch {
    return null;
  }
}

function saveMeta(meta: ReleaseMeta): void {
  fs.writeFileSync(META_PATH, JSON.stringify(meta, null, 2), 'utf-8');
}

function isCheckStale(meta: ReleaseMeta): boolean {
  const checked = new Date(meta.checked_at);
  const now = new Date();
  const diffMs = now.getTime() - checked.getTime();
  const diffDays = diffMs / (1000 * 60 * 60 * 24);
  return diffDays >= 7;
}

function openAndIndex(dbPath: string): void {
  db = new DatabaseSync(dbPath);

  // Vector layer: load all embeddings into memory for cosine similarity
  process.stderr.write('[entra-news-podcast-mcp] Loading embeddings into memory...\n');
  const embRows = db
    .prepare('SELECT chunk_id, embedding FROM vec_embeddings')
    .all() as Array<{ chunk_id: number; embedding: Buffer }>;

  embeddingCache = embRows.map((r) => {
    const buf = Buffer.from(r.embedding);
    const embedding = new Float32Array(
      buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)
    );
    return { chunk_id: r.chunk_id, embedding, norm: vecNorm(embedding) };
  });

  // Keyword layer: build the BM25 inverted index over chunk text + headings
  process.stderr.write('[entra-news-podcast-mcp] Building BM25 index...\n');
  const chunkRows = db
    .prepare('SELECT id, text, section_heading FROM chunks')
    .all() as Array<{ id: number; text: string; section_heading: string | null }>;

  bm25.build(
    chunkRows.map((r) => ({
      id: r.id,
      text: r.section_heading ? `${r.text} ${r.section_heading}` : r.text,
    }))
  );

  process.stderr.write(
    `[entra-news-podcast-mcp] Ready — ${bm25.size} chunks indexed (${embeddingCache.length} with embeddings).\n`
  );
}

export async function initDb(): Promise<void> {
  // Allow a local DB path override — useful for development / testing
  const localOverride = process.env.ENTRA_PODCAST_DB_PATH;
  if (localOverride) {
    if (!fs.existsSync(localOverride)) {
      throw new Error(`ENTRA_PODCAST_DB_PATH points to a file that does not exist: ${localOverride}`);
    }
    process.stderr.write(`[entra-news-podcast-mcp] Using local database: ${localOverride}\n`);
    openAndIndex(localOverride);
    return;
  }

  if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });

  const dbExists = fs.existsSync(DB_PATH);
  const cached = loadCachedMeta();

  let shouldDownload = false;
  let latestMeta: ReleaseMeta | null = null;

  if (!dbExists) {
    process.stderr.write('[entra-news-podcast-mcp] No local database found. Downloading from GitHub Releases...\n');
    latestMeta = await getLatestRelease();
    shouldDownload = latestMeta !== null;
  } else if (!cached || isCheckStale(cached)) {
    process.stderr.write('[entra-news-podcast-mcp] Checking for database updates...\n');
    latestMeta = await getLatestRelease();
    if (latestMeta && cached && latestMeta.tag !== cached.tag) {
      process.stderr.write(`[entra-news-podcast-mcp] New version available: ${latestMeta.tag}. Updating...\n`);
      shouldDownload = true;
    } else if (latestMeta && !cached) {
      shouldDownload = true;
    } else if (latestMeta) {
      // Up to date — just refresh the check timestamp
      saveMeta({ ...latestMeta, checked_at: new Date().toISOString() });
    }
  }

  if (shouldDownload && latestMeta) {
    process.stderr.write(`[entra-news-podcast-mcp] Downloading ${DB_FILENAME} (${latestMeta.tag})...\n`);
    await downloadFile(latestMeta.asset_url, DB_PATH);
    saveMeta(latestMeta);
    process.stderr.write('[entra-news-podcast-mcp] Database downloaded.\n');
  } else if (!dbExists) {
    throw new Error(
      'No local database found and could not download from GitHub Releases. ' +
        'Please run the ingestion script first or check your internet connection.'
    );
  }

  openAndIndex(DB_PATH);
}

export function getDb(): DatabaseSync {
  if (!db) throw new Error('Database not initialised. Call initDb() first.');
  return db;
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

/** Hydrate ranked chunk IDs into full SearchResults, preserving rank order. */
function hydrateChunks(rankedIds: number[]): SearchResult[] {
  if (rankedIds.length === 0) return [];
  const placeholders = rankedIds.map(() => '?').join(',');
  const rows = getDb()
    .prepare(
      `SELECT c.id AS chunk_id, c.text, c.section_heading, c.start_time,
              e.video_id, e.episode_number, e.title, e.published_at, e.url,
              (SELECT group_concat(g.name, ', ')
               FROM episode_guests eg JOIN guests g ON g.id = eg.guest_id
               WHERE eg.episode_id = e.id) AS guests
       FROM chunks c JOIN episodes e ON e.id = c.episode_id
       WHERE c.id IN (${placeholders})`
    )
    .all(...rankedIds) as unknown as Array<Omit<SearchResult, 'distance'>>;

  const byId = new Map(rows.map((r) => [r.chunk_id, r]));
  const results: SearchResult[] = [];
  rankedIds.forEach((id, rank) => {
    const row = byId.get(id);
    if (row) results.push({ ...row, distance: rank });
  });
  return results;
}

/** Vector search over the in-memory embedding cache. Returns ranked results. */
export function semanticSearch(queryEmbedding: Float32Array, limit = 10): SearchResult[] {
  const queryNorm = vecNorm(queryEmbedding);

  const scored = embeddingCache.map((e) => ({
    chunk_id: e.chunk_id,
    score: cosineSimilarity(queryEmbedding, queryNorm, e.embedding, e.norm),
  }));
  scored.sort((a, b) => b.score - a.score);
  return hydrateChunks(scored.slice(0, limit).map((s) => s.chunk_id));
}

/** BM25 keyword search over the in-memory inverted index. Returns ranked results. */
export function keywordSearch(query: string, limit = 10): SearchResult[] {
  const hits = bm25.search(query, limit);
  return hydrateChunks(hits.map((h) => h.chunk_id));
}

export function hasEmbeddings(): boolean {
  return embeddingCache.length > 0;
}

// ---------------------------------------------------------------------------
// Episodes
// ---------------------------------------------------------------------------

export function getEpisodeByVideoId(videoId: string): Episode | null {
  return (
    (getDb()
      .prepare('SELECT * FROM episodes WHERE video_id = ? LIMIT 1')
      .get(videoId) as Episode | undefined) ?? null
  );
}

export function getEpisodeByNumber(episodeNumber: number): Episode | null {
  return (
    (getDb()
      .prepare('SELECT * FROM episodes WHERE episode_number = ? LIMIT 1')
      .get(episodeNumber) as Episode | undefined) ?? null
  );
}

export function getEpisodeByDate(dateStr: string): Episode | null {
  return (
    (getDb()
      .prepare(
        'SELECT * FROM episodes WHERE published_at LIKE ? ORDER BY published_at ASC LIMIT 1'
      )
      .get(`${dateStr}%`) as Episode | undefined) ?? null
  );
}

/** Chapter list for an episode, derived from chunk section headings. */
export function getEpisodeChapters(episodeId: number): Chapter[] {
  return getDb()
    .prepare(
      `SELECT section_heading, MIN(start_time) AS start_time
       FROM chunks
       WHERE episode_id = ? AND section_heading IS NOT NULL
         AND section_heading NOT LIKE '<Untitled%'
       GROUP BY section_heading
       ORDER BY start_time`
    )
    .all(episodeId) as unknown as Chapter[];
}

export function listEpisodes(
  opts: { year?: number; month?: number; guest?: string; limit?: number; offset?: number } = {}
): Episode[] {
  const conditions: string[] = [];
  const params: (string | number)[] = [];

  if (opts.year) {
    conditions.push("strftime('%Y', e.published_at) = ?");
    params.push(String(opts.year));
  }
  if (opts.month) {
    conditions.push("strftime('%m', e.published_at) = ?");
    params.push(String(opts.month).padStart(2, '0'));
  }
  if (opts.guest) {
    conditions.push(
      `e.id IN (SELECT eg.episode_id FROM episode_guests eg
                JOIN guests g ON g.id = eg.guest_id
                WHERE g.name LIKE ?)`
    );
    params.push(`%${opts.guest}%`);
  }

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const limit = opts.limit ?? 50;
  const offset = opts.offset ?? 0;
  params.push(limit, offset);

  return getDb()
    .prepare(`SELECT e.* FROM episodes e ${where} ORDER BY e.published_at DESC LIMIT ? OFFSET ?`)
    .all(...params) as unknown as Episode[];
}

// ---------------------------------------------------------------------------
// Guests
// ---------------------------------------------------------------------------

export function getGuestsForEpisode(episodeId: number): Guest[] {
  return getDb()
    .prepare(
      `SELECT g.* FROM guests g
       JOIN episode_guests eg ON eg.guest_id = g.id
       WHERE eg.episode_id = ?
       ORDER BY g.name`
    )
    .all(episodeId) as unknown as Guest[];
}

export function listGuests(
  opts: { query?: string; limit?: number; offset?: number } = {}
): GuestSummary[] {
  const params: (string | number)[] = [];
  let where = '';
  if (opts.query) {
    where = 'WHERE g.name LIKE ?';
    params.push(`%${opts.query}%`);
  }
  params.push(opts.limit ?? 50, opts.offset ?? 0);

  return getDb()
    .prepare(
      `SELECT g.*,
              COUNT(eg.episode_id) AS episode_count,
              MAX(e.published_at) AS latest_appearance
       FROM guests g
       LEFT JOIN episode_guests eg ON eg.guest_id = g.id
       LEFT JOIN episodes e ON e.id = eg.episode_id
       ${where}
       GROUP BY g.id
       ORDER BY episode_count DESC, latest_appearance DESC
       LIMIT ? OFFSET ?`
    )
    .all(...params) as unknown as GuestSummary[];
}

/**
 * Find guests matching a name (case-insensitive substring). An exact
 * case-insensitive match wins outright when present.
 */
export function findGuestsByName(name: string): Guest[] {
  const database = getDb();
  const exact = database
    .prepare('SELECT * FROM guests WHERE LOWER(name) = LOWER(?)')
    .all(name) as unknown as Guest[];
  if (exact.length > 0) return exact;

  return database
    .prepare('SELECT * FROM guests WHERE name LIKE ? ORDER BY name')
    .all(`%${name}%`) as unknown as Guest[];
}

export function getEpisodesForGuest(guestId: number): Episode[] {
  return getDb()
    .prepare(
      `SELECT e.* FROM episodes e
       JOIN episode_guests eg ON eg.episode_id = e.id
       WHERE eg.guest_id = ?
       ORDER BY e.published_at DESC`
    )
    .all(guestId) as unknown as Episode[];
}

// ---------------------------------------------------------------------------
// Tool mentions
// ---------------------------------------------------------------------------

export function findToolMentions(query?: string, limit = 20): ToolMention[] {
  const database = getDb();

  if (query) {
    const like = `%${query}%`;
    const fromTable = database
      .prepare(
        `SELECT t.*, e.episode_number, e.title AS episode_title, e.video_id,
                e.published_at, e.url AS episode_url
         FROM tool_mentions t
         JOIN episodes e ON e.id = t.episode_id
         WHERE t.tool_name LIKE ? OR t.context LIKE ?
         ORDER BY e.published_at DESC
         LIMIT ?`
      )
      .all(like, like, limit) as unknown as ToolMention[];

    if (fromTable.length > 0) return fromTable;

    // Fallback: search chunk text for the query term and synthesise mentions
    const fromChunks = database
      .prepare(
        `SELECT c.id, c.text, c.start_time, e.id AS episode_id, e.episode_number,
                e.title AS episode_title, e.video_id, e.published_at, e.url AS episode_url
         FROM chunks c
         JOIN episodes e ON e.id = c.episode_id
         WHERE c.text LIKE ?
         GROUP BY e.id
         ORDER BY e.published_at DESC
         LIMIT ?`
      )
      .all(like, limit) as unknown as Array<{
        id: number;
        text: string;
        start_time: number | null;
        episode_id: number;
        episode_number: number | null;
        episode_title: string;
        video_id: string;
        published_at: string;
        episode_url: string;
      }>;

    return fromChunks.map((row) => {
      // Extract ~200 chars around the first match as context
      const lower = row.text.toLowerCase();
      const qi = lower.indexOf(query.toLowerCase());
      const start = Math.max(0, qi - 100);
      const end = Math.min(row.text.length, qi + query.length + 100);
      const context =
        qi >= 0
          ? '...' + row.text.slice(start, end).replace(/\s+/g, ' ').trim() + '...'
          : row.text.slice(0, 200);

      return {
        id: -row.id, // negative = synthetic (from chunks, not tool_mentions)
        episode_id: row.episode_id,
        episode_number: row.episode_number,
        episode_title: row.episode_title,
        video_id: row.video_id,
        published_at: row.published_at,
        episode_url: row.episode_url,
        tool_name: query.replace(/\b\w/g, (c) => c.toUpperCase()),
        context: context.slice(0, 500),
        start_time: row.start_time,
      } satisfies ToolMention;
    });
  }

  return database
    .prepare(
      `SELECT t.*, e.episode_number, e.title AS episode_title, e.video_id,
              e.published_at, e.url AS episode_url
       FROM tool_mentions t
       JOIN episodes e ON e.id = t.episode_id
       ORDER BY e.published_at DESC
       LIMIT ?`
    )
    .all(limit) as unknown as ToolMention[];
}

export function getDbMeta(): Record<string, string> {
  try {
    const rows = getDb().prepare('SELECT key, value FROM meta').all() as Array<{ key: string; value: string }>;
    return Object.fromEntries(rows.map((r) => [r.key, r.value]));
  } catch {
    return {};
  }
}
