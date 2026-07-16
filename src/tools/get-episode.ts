import { z } from 'zod';
import {
  getEpisodeByVideoId,
  getEpisodeByNumber,
  getEpisodeByDate,
  getEpisodeChapters,
  getGuestsForEpisode,
  Episode,
} from '../db/client.js';
import { deepLink, formatDate, formatGuestLinks, formatTimestamp } from '../utils/format.js';

export const getEpisodeSchema = z.object({
  video_id: z
    .string()
    .optional()
    .describe('YouTube video ID (11 characters, e.g. "dQw4w9WgXcQ")'),
  episode_number: z
    .number()
    .int()
    .positive()
    .optional()
    .describe('Episode number (e.g. 12)'),
  date: z
    .string()
    .optional()
    .describe('Date in YYYY-MM-DD or YYYY-MM format to find the nearest episode'),
});

type GetEpisodeArgs = z.infer<typeof getEpisodeSchema>;

export function handleGetEpisode(args: GetEpisodeArgs): string {
  if (!args.video_id && args.episode_number == null && !args.date) {
    return 'Please provide a video_id, episode_number, or date to look up.';
  }

  let episode: Episode | null = null;

  if (args.video_id) {
    episode = getEpisodeByVideoId(args.video_id);
    if (!episode) return `No episode found with video ID "${args.video_id}".`;
  } else if (args.episode_number != null) {
    episode = getEpisodeByNumber(args.episode_number);
    if (!episode) return `Episode #${args.episode_number} not found in the archive.`;
  } else if (args.date) {
    episode = getEpisodeByDate(args.date);
    if (!episode) {
      return `No episode found for date "${args.date}". Try a broader date range (e.g. just the year-month like "2026-03").`;
    }
  }

  if (!episode) return 'Episode not found.';

  const episodeRef = episode.episode_number != null ? `Episode #${episode.episode_number}` : 'Entra.Chat';
  const duration = episode.duration_sec != null ? formatTimestamp(episode.duration_sec) : 'unknown';

  const guests = getGuestsForEpisode(episode.id);
  const guestLines = guests.map((g) => {
    const links = formatGuestLinks(g);
    return `- **${g.name}**${links ? ` — ${links}` : ''}`;
  });

  const chapters = episode.has_chapters ? getEpisodeChapters(episode.id) : [];
  const chapterLines = chapters.map((ch) => {
    const ts = ch.start_time != null ? `[${formatTimestamp(ch.start_time)}]` : '';
    return `- ${ts} ${ch.section_heading} — ${deepLink(episode!.video_id, ch.start_time)}`;
  });

  const parts = [
    `## ${episodeRef}: ${episode.title}`,
    '',
    `**Published:** ${formatDate(episode.published_at)}`,
    `**Duration:** ${duration}`,
    `**Transcript source:** ${episode.transcript_source === 'manual' ? 'uploaded captions' : 'auto-generated captions'}`,
    `**Watch:** ${episode.url}`,
  ];

  if (guestLines.length > 0) {
    parts.push('', '**Guest(s):**', ...guestLines);
  }

  if (chapterLines.length > 0) {
    parts.push('', '**Chapters:**', ...chapterLines);
  }

  parts.push('', '---', '', episode.transcript?.trim() || '*No transcript available for this episode.*');

  return parts.join('\n');
}
