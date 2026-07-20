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

// YouTube's datacenter-IP bot detection. When this fires, abort the whole run
// loudly rather than producing a silently partial database.
const BOT_BLOCK_RE = /sign in to confirm|not a bot|HTTP Error 429|HTTP Error 403/i;

export class BotBlockedError extends Error {
  constructor(detail: string) {
    super(
      `BOT_BLOCKED: YouTube is blocking transcript downloads from this IP. ` +
        `Set YTDLP_PROXY to route requests through a proxy, or re-run the ` +
        `ingest from a residential IP and upload the DB manually ` +
        `(see README "Manual database refresh"). Detail: ${detail.slice(0, 500)}`
    );
    this.name = 'BotBlockedError';
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
    if (BOT_BLOCK_RE.test(detail)) {
      throw new BotBlockedError(detail.trim());
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
 * Fetch metadata + captions for one video in a single yt-dlp invocation.
 * Prefers uploaded (manual) captions over auto-generated; prefers json3
 * (each word appears exactly once with its own offset — no VTT rolling-window
 * duplication) over vtt.
 */
export async function fetchVideo(videoId: string, tmpDir: string): Promise<VideoFetchResult> {
  fs.mkdirSync(tmpDir, { recursive: true });

  await runYtDlp([
    '--skip-download',
    '--write-info-json',
    '--write-subs',
    '--write-auto-subs',
    '--sub-langs', 'en.*,en',
    '--sub-format', 'json3/vtt',
    '--sleep-requests', '1.5',
    '--sleep-subtitles', '2',
    '--retries', '5',
    '--retry-sleep', '10',
    '-o', '%(id)s',
    '-P', tmpDir,
    `https://www.youtube.com/watch?v=${videoId}`,
  ]);

  const infoPath = path.join(tmpDir, `${videoId}.info.json`);
  if (!fs.existsSync(infoPath)) {
    throw new Error(`yt-dlp did not produce ${videoId}.info.json`);
  }
  const info = JSON.parse(fs.readFileSync(infoPath, 'utf-8')) as VideoInfo;

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
