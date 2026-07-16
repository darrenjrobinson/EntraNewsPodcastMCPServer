/**
 * Caption parsing and chunking.
 *
 * Primary format is YouTube json3: each word appears exactly once with its own
 * millisecond offset, so there is no rolling-caption duplication to clean up.
 * A small VTT fallback parser handles the rare video that offers vtt only.
 */

import { VideoChapter } from './ytdlp.js';

export interface TimedWord {
  word: string;
  tSec: number;
}

export interface ChunkData {
  section_heading: string | null;
  start_time: number | null;
  end_time: number | null;
  text: string;
}

// Spoken ≈150 wpm → 200 words ≈ 80 seconds of audio, matching the PRD's
// 60–90s chunk guidance while keeping word-based mechanics.
const CHUNK_TARGET_WORDS = 200;
const CHUNK_OVERLAP_WORDS = 40;
const MIN_PARTITION_WORDS = 30;

// Common auto-caption mis-transcriptions of identity terms. Applied to final
// text (chunks + full transcript), not to individual timed words.
const MIS_TRANSCRIPTIONS: Array<[RegExp, string]> = [
  [/\bentra\s+eye\s+dee\b/gi, 'Entra ID'],
  [/\bentra\s+i\s+d\b/gi, 'Entra ID'],
  [/\bintra\s+id\b/gi, 'Entra ID'],
  [/\bazure\s+a\s+d\b/gi, 'Azure AD'],
  [/\bmy\s+ester\b/gi, 'Maester'],
  [/\bcondition\s+access\b/gi, 'Conditional Access'],
];

export function cleanTranscriptText(text: string): string {
  let out = text.replace(/\s+/g, ' ').trim();
  for (const [re, replacement] of MIS_TRANSCRIPTIONS) {
    out = out.replace(re, replacement);
  }
  return out;
}

// ---------------------------------------------------------------------------
// json3 parsing
// ---------------------------------------------------------------------------

interface Json3Doc {
  events?: Array<{
    tStartMs?: number;
    dDurationMs?: number;
    aAppend?: number;
    segs?: Array<{ utf8: string; tOffsetMs?: number }>;
  }>;
}

export function parseJson3(raw: string): TimedWord[] {
  const doc = JSON.parse(raw) as Json3Doc;
  const words: TimedWord[] = [];

  for (const event of doc.events ?? []) {
    if (!event.segs || event.tStartMs == null) continue;
    // aAppend events re-emit text for the rolling caption window — skip them
    if (event.aAppend) continue;

    for (const seg of event.segs) {
      const w = seg.utf8?.trim();
      if (!w || w === '\n') continue;
      if (/^\[.*\]$/.test(w)) continue; // [Music], [Applause], ...
      const tSec = (event.tStartMs + (seg.tOffsetMs ?? 0)) / 1000;
      // json3 segments are usually single words but can contain phrases
      for (const word of w.split(/\s+/).filter(Boolean)) {
        words.push({ word, tSec });
      }
    }
  }

  return collapseRepeats(words);
}

// ---------------------------------------------------------------------------
// VTT fallback parsing
// ---------------------------------------------------------------------------

function vttTimeToSec(t: string): number {
  const m = t.trim().match(/(?:(\d+):)?(\d+):(\d+)\.(\d+)/);
  if (!m) return 0;
  const h = m[1] ? parseInt(m[1], 10) : 0;
  return h * 3600 + parseInt(m[2], 10) * 60 + parseInt(m[3], 10) + parseInt(m[4], 10) / 1000;
}

/**
 * Auto-sub VTT re-emits every line across consecutive rolling-window cues.
 * Strategy: strip inline word-timing tags, then only emit a line if it differs
 * from the previously emitted line. All words in a line get the cue start time.
 */
export function parseVtt(raw: string): TimedWord[] {
  const words: TimedWord[] = [];
  let lastEmitted = '';
  let cueStart = 0;

  for (const line of raw.split(/\r?\n/)) {
    const timeMatch = line.match(/^([\d:.]+)\s+-->\s+([\d:.]+)/);
    if (timeMatch) {
      cueStart = vttTimeToSec(timeMatch[1]);
      continue;
    }
    if (!line.trim() || line.startsWith('WEBVTT') || /^(Kind|Language|NOTE|STYLE):?/i.test(line)) {
      continue;
    }

    // Strip inline tags: <00:00:01.234>, <c>, </c>
    const clean = line.replace(/<[^>]*>/g, '').trim();
    if (!clean || clean === lastEmitted) continue;
    if (/^\[.*\]$/.test(clean)) continue;
    lastEmitted = clean;

    for (const word of clean.split(/\s+/).filter(Boolean)) {
      words.push({ word, tSec: cueStart });
    }
  }

  return collapseRepeats(words);
}

/** Collapse immediate word repeats ("the the") from caption glitches. */
function collapseRepeats(words: TimedWord[]): TimedWord[] {
  return words.filter(
    (w, i) => i === 0 || w.word.toLowerCase() !== words[i - 1].word.toLowerCase()
  );
}

// ---------------------------------------------------------------------------
// Chunking
// ---------------------------------------------------------------------------

interface Partition {
  heading: string | null;
  words: TimedWord[];
}

/** Partition timed words by chapter boundaries; chunks never cross chapters. */
function partitionByChapters(words: TimedWord[], chapters: VideoChapter[] | null): Partition[] {
  if (!chapters || chapters.length === 0) {
    return [{ heading: null, words }];
  }

  const sorted = [...chapters].sort((a, b) => a.start_time - b.start_time);
  // YouTube emits "<Untitled Chapter 1>" placeholders — keep the boundary, drop the label
  const partitions: Partition[] = sorted.map((ch) => ({
    heading: /^<Untitled/i.test(ch.title) ? null : ch.title,
    words: [],
  }));

  for (const w of words) {
    // Find the last chapter whose start_time <= word time (words before the
    // first chapter and after the last chapter end land in the nearest one)
    let idx = 0;
    for (let i = 0; i < sorted.length; i++) {
      if (w.tSec >= sorted[i].start_time) idx = i;
      else break;
    }
    partitions[idx].words.push(w);
  }

  // Merge tiny partitions into their predecessor so we don't emit stub chunks
  const merged: Partition[] = [];
  for (const p of partitions) {
    if (p.words.length === 0) continue;
    if (p.words.length < MIN_PARTITION_WORDS && merged.length > 0) {
      merged[merged.length - 1].words.push(...p.words);
    } else {
      merged.push(p);
    }
  }
  return merged.length > 0 ? merged : [{ heading: null, words }];
}

export function chunkTranscript(
  words: TimedWord[],
  chapters: VideoChapter[] | null
): ChunkData[] {
  if (words.length === 0) return [];

  const chunks: ChunkData[] = [];

  for (const partition of partitionByChapters(words, chapters)) {
    const pw = partition.words;
    let start = 0;
    while (start < pw.length) {
      const end = Math.min(start + CHUNK_TARGET_WORDS, pw.length);
      const slice = pw.slice(start, end);
      chunks.push({
        section_heading: partition.heading,
        start_time: slice[0].tSec,
        end_time: slice[slice.length - 1].tSec,
        text: cleanTranscriptText(slice.map((w) => w.word).join(' ')),
      });
      if (end >= pw.length) break;
      start = end - CHUNK_OVERLAP_WORDS;
    }
  }

  return chunks;
}

// ---------------------------------------------------------------------------
// Full transcript (stored on the episode row — no chunk-overlap duplication)
// ---------------------------------------------------------------------------

const MARKER_INTERVAL_SEC = 30;

export function buildFullTranscript(words: TimedWord[]): string {
  if (words.length === 0) return '';

  const parts: string[] = [];
  let lastMarker = -Infinity;

  for (const w of words) {
    if (w.tSec - lastMarker >= MARKER_INTERVAL_SEC) {
      const s = Math.floor(w.tSec);
      const h = Math.floor(s / 3600);
      const m = Math.floor((s % 3600) / 60);
      const sec = String(s % 60).padStart(2, '0');
      const stamp = h > 0 ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`;
      parts.push(`\n[${stamp}]`);
      lastMarker = w.tSec;
    }
    parts.push(w.word);
  }

  return cleanTranscriptText(parts.join(' ').trim()).replace(/ ?\n ?/g, '\n');
}
