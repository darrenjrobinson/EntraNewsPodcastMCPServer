/**
 * yt-dlp wrappers for the ingest pipeline. yt-dlp is an external binary
 * (pipx/winget install) used ONLY at ingest time — it is never required on
 * end-user machines running the published MCP server.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import * as fs from 'fs';
import * as path from 'path';

const execFileAsync = promisify(execFile);
const MAX_BUFFER = 64 * 1024 * 1024;

// YouTube's datacenter-IP bot detection on general page/API requests. When
// this fires, abort the whole run loudly rather than producing a silently
// partial database.
const BOT_BLOCK_RE = /sign in to confirm|not a bot|HTTP Error 429|HTTP Error 403/i;

// yt-dlp's YouTube extractor requires a TLS impersonation backend for caption
// downloads. Without one YouTube still answers with an HTTP 403, so this must
// be tested BEFORE BOT_BLOCK_RE: the 403 is the symptom, the missing backend
// is the cause, and the two have completely different remedies.
const IMPERSONATION_RE = /no impersonate target is available/i;

// YouTube's caption/timedtext endpoint specifically requires a PO
// (Proof-of-Origin) token for the web/web_safari clients yt-dlp uses by
// default — without one, subtitle downloads 429 regardless of source IP.
// Confirmed 2026-09-09: the identical failure reproduced from four different
// exit IPs (two IPRoyal identities in two countries, plus a clean home
// residential IP with no proxy at all) on both a brand-new and an
// already-successfully-ingested video. A proxy does NOT fix this — see
// yt-dlp#13831 and https://github.com/yt-dlp/yt-dlp/wiki/PO-Token-Guide.
// Must be tested BEFORE the general BOT_BLOCK_RE (same 429 text) since the
// remedy is completely different (PO token provider, not IP/proxy).
const SUBTITLE_POT_RE = /unable to download video subtitles.*HTTP Error 429/is;

/**
 * yt-dlp prints warnings first and the fatal ERROR last, so truncating the
 * head of stderr can hide the real cause behind repeated warnings. Prefer
 * explicit ERROR: lines; otherwise keep the tail.
 */
function failureDetail(detail: string, limit = 1500): string {
  const errors = detail
    .split('\n')
    .filter((l) => /^\s*ERROR:/i.test(l))
    .map((l) => l.trim());
  if (errors.length > 0) return errors.join(' | ').slice(0, limit);
  return detail.trim().slice(-limit);
}

/**
 * Base for failures that will affect every subsequent video identically — the
 * ingest aborts on these rather than building a silently partial database.
 */
export class IngestBlockedError extends Error {}

export class BotBlockedError extends IngestBlockedError {
  constructor(detail: string) {
    super(
      `BOT_BLOCKED: YouTube is blocking transcript downloads from this IP. ` +
        `Set YTDLP_PROXY to route requests through a proxy, or re-run the ` +
        `ingest from a residential IP and upload the DB manually ` +
        `(see README "Manual database refresh"). Detail: ${detail}`
    );
    this.name = 'BotBlockedError';
  }
}

export class ImpersonationUnavailableError extends IngestBlockedError {
  constructor(detail: string) {
    super(
      `IMPERSONATION_UNAVAILABLE: yt-dlp needs a TLS impersonation backend to ` +
        `download YouTube captions, but none is installed. Install yt-dlp with ` +
        `the curl-cffi extra: pipx install "yt-dlp[default,curl-cffi]". This is ` +
        `NOT an IP or proxy problem — setting YTDLP_PROXY will not help. ` +
        `Detail: ${detail}`
    );
    this.name = 'ImpersonationUnavailableError';
  }
}

export class PoTokenRequiredError extends IngestBlockedError {
  constructor(detail: string) {
    super(
      `PO_TOKEN_REQUIRED: YouTube's caption endpoint is rejecting subtitle ` +
        `downloads with 429 because no PO (Proof-of-Origin) token is being ` +
        `supplied. This is NOT an IP/proxy problem — YTDLP_PROXY will not ` +
        `help (confirmed by reproducing this identically from four different ` +
        `exit IPs). Install the PO token provider plugin: see README "PO ` +
        `token provider (yt-dlp caption downloads)". Detail: ${detail}`
    );
    this.name = 'PoTokenRequiredError';
  }
}

export interface PlaylistEntry {
  video_id: string;
  title: string;
}

export interface VideoChapter {
  start_time: number;
  end_time: number;
  title: string;
}

export interface VideoInfo {
  id: string;
  title: string;
  channel: string;
  upload_date: string; // YYYYMMDD
  duration: number | null;
  webpage_url: string;
  description: string | null;
  chapters: VideoChapter[] | null;
  subtitles?: Record<string, unknown>;
  automatic_captions?: Record<string, unknown>;
}

export interface VideoFetchResult {
  info: VideoInfo;
  captionPath: string | null;
  captionFormat: 'json3' | 'vtt' | null;
  transcriptSource: 'manual' | 'auto' | null;
}

async function runYtDlp(args: string[]): Promise<{ stdout: string; stderr: string }> {
  // Escape hatch for datacenter-IP blocking: route all yt-dlp traffic through
  // a proxy (e.g. residential) without touching any call site.
  const proxy = process.env.YTDLP_PROXY;
  const fullArgs = proxy ? ['--proxy', proxy, ...args] : args;
  try {
    return await execFileAsync('yt-dlp', fullArgs, { maxBuffer: MAX_BUFFER });
  } catch (err) {
    const e = err as { stderr?: string; stdout?: string; message?: string };
    const detail = `${e.stderr ?? ''}\n${e.message ?? ''}`;
    if (IMPERSONATION_RE.test(detail)) {
      throw new ImpersonationUnavailableError(failureDetail(detail));
    }
    if (SUBTITLE_POT_RE.test(detail)) {
      throw new PoTokenRequiredError(failureDetail(detail));
    }
    if (BOT_BLOCK_RE.test(detail)) {
      throw new BotBlockedError(failureDetail(detail));
    }
    throw err;
  }
}

export async function ytDlpVersion(): Promise<string> {
  const { stdout } = await runYtDlp(['--version']);
  return stdout.trim();
}

/** List all videos in a playlist (one network call, newest data from YouTube). */
export async function listPlaylist(playlistUrl: string): Promise<PlaylistEntry[]> {
  const { stdout } = await runYtDlp([
    '--flat-playlist',
    '--print', '%(id)s|%(title)s',
    '--sleep-requests', '1.5',
    '--retries', '5',
    '--retry-sleep', '5',
    playlistUrl,
  ]);

  return stdout
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((line) => {
      // YouTube video IDs are always 11 characters; titles may contain '|'
      const sep = line.indexOf('|');
      return { video_id: line.slice(0, sep), title: line.slice(sep + 1) };
    })
    .filter((e) => e.video_id.length === 11);
}

/**
 * Some videos (multi-audio-track uploads — YouTube's dubbing feature) split
 * their caption listing into per-track native "<lang>-orig" transcripts plus
 * a separate bare "<lang>" bucket that bundles auto-*translations* FROM every
 * other track INTO <lang>. The bare bucket is what a naive 'en.*,en' pattern
 * matches first (alphabetically "en" sorts before "en-orig"), and YouTube's
 * translate-on-the-fly timedtext endpoint throttles that bucket far more
 * aggressively (immediate 429) than a direct transcript — confirmed
 * 2026-09-09 on C7nc-itxl28: 20 dub tracks, "en-orig" downloads cleanly,
 * "en" 429s every time regardless of IP/PO-token, and yt-dlp aborts the
 * whole fetch on that first failure before ever trying "en-orig". So: look
 * at what's actually available before requesting, and ask for exactly one
 * key — never a pattern that can match both the safe and risky variant.
 */
function pickCaptionLanguage(info: VideoInfo): string | null {
  const findEnglish = (keys: string[]): string | null =>
    keys.find((k) => /^en-orig$/i.test(k)) ??
    keys.find((k) => /^en$/i.test(k)) ??
    keys.find((k) => /^en/i.test(k)) ??
    null;

  // Manual (uploaded) captions take priority over auto-generated regardless.
  return (
    findEnglish(Object.keys(info.subtitles ?? {})) ??
    findEnglish(Object.keys(info.automatic_captions ?? {}))
  );
}

/**
 * Fetch metadata + captions for one video. Two yt-dlp calls: metadata first
 * (to see which caption language keys actually exist — see
 * pickCaptionLanguage above), then captions for exactly the one resolved
 * key. Prefers uploaded (manual) captions over auto-generated; prefers json3
 * (each word appears exactly once with its own offset — no VTT rolling-window
 * duplication) over vtt.
 */
export async function fetchVideo(videoId: string, tmpDir: string): Promise<VideoFetchResult> {
  fs.mkdirSync(tmpDir, { recursive: true });

  await runYtDlp([
    '--skip-download',
    '--write-info-json',
    '--sleep-requests', '1.5',
    '--retries', '5',
    '--retry-sleep', '5',
    '-o', '%(id)s',
    '-P', tmpDir,
    `https://www.youtube.com/watch?v=${videoId}`,
  ]);

  const infoPath = path.join(tmpDir, `${videoId}.info.json`);
  if (!fs.existsSync(infoPath)) {
    throw new Error(`yt-dlp did not produce ${videoId}.info.json`);
  }
  const info = JSON.parse(fs.readFileSync(infoPath, 'utf-8')) as VideoInfo;

  const subLang = pickCaptionLanguage(info);
  if (subLang) {
    await runYtDlp([
      '--skip-download',
      '--write-subs',
      '--write-auto-subs',
      '--sub-langs', subLang,
      '--sub-format', 'json3/vtt',
      '--sleep-requests', '1.5',
      '--sleep-subtitles', '2',
      '--retries', '5',
      '--retry-sleep', '10',
      '-o', '%(id)s',
      '-P', tmpDir,
      `https://www.youtube.com/watch?v=${videoId}`,
    ]);
  }

  // Locate the best caption file: json3 over vtt, non "-orig" language first
  const captionFiles = fs
    .readdirSync(tmpDir)
    .filter((f) => f.startsWith(`${videoId}.`) && (f.endsWith('.json3') || f.endsWith('.vtt')));

  const rank = (f: string): number => {
    let score = 0;
    if (f.endsWith('.json3')) score += 2;
    if (!f.includes('-orig')) score += 1;
    return score;
  };
  captionFiles.sort((a, b) => rank(b) - rank(a));

  const best = captionFiles[0] ?? null;
  const captionPath = best ? path.join(tmpDir, best) : null;
  const captionFormat = best ? (best.endsWith('.json3') ? 'json3' : 'vtt') : null;

  // info.json distinguishes uploaded captions (subtitles) from auto captions
  const hasManual = Object.keys(info.subtitles ?? {}).some((k) => k.startsWith('en'));
  const transcriptSource = best ? (hasManual ? 'manual' : 'auto') : null;

  return { info, captionPath, captionFormat, transcriptSource };
}

/** Remove one video's temp files after ingestion. */
export function cleanupVideoFiles(videoId: string, tmpDir: string): void {
  try {
    for (const f of fs.readdirSync(tmpDir)) {
      if (f.startsWith(`${videoId}.`)) {
        fs.unlinkSync(path.join(tmpDir, f));
      }
    }
  } catch {
    // best-effort cleanup
  }
}
