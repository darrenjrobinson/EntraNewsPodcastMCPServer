import { z } from 'zod';
import { listEpisodes, getGuestsForEpisode, getDbMeta, Episode } from '../db/client.js';
import { formatTimestamp } from '../utils/format.js';

export const listEpisodesSchema = z.object({
  year: z
    .number()
    .int()
    .min(2020)
    .max(2035)
    .optional()
    .describe('Filter by year (e.g. 2026)'),
  month: z
    .number()
    .int()
    .min(1)
    .max(12)
    .optional()
    .describe('Filter by month number (1–12). Requires year to be set.'),
  guest: z
    .string()
    .optional()
    .describe('Filter to episodes featuring a guest whose name contains this text'),
  limit: z
    .number()
    .int()
    .min(1)
    .max(200)
    .default(50)
    .describe('Maximum episodes to return'),
  offset: z
    .number()
    .int()
    .min(0)
    .default(0)
    .describe('Pagination offset'),
});

type ListEpisodesArgs = z.infer<typeof listEpisodesSchema>;

const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

function formatEpisodeRow(episode: Episode): string {
  const date = new Date(episode.published_at).toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
  const episodeRef =
    episode.episode_number != null ? `#${String(episode.episode_number).padStart(3, ' ')}` : '   ';
  const duration = episode.duration_sec != null ? formatTimestamp(episode.duration_sec) : '';
  const guests = getGuestsForEpisode(episode.id).map((g) => g.name).join(', ');
  const guestNote = guests ? ` — with ${guests}` : '';
  return `${episodeRef}  ${date.padEnd(12)}  ${duration.padStart(7)}  [${episode.title}](${episode.url})${guestNote}`;
}

export function handleListEpisodes(args: ListEpisodesArgs): string {
  const { year, month, guest, limit, offset } = args;

  const episodes = listEpisodes({ year, month, guest, limit, offset });
  const meta = getDbMeta();

  if (episodes.length === 0) {
    const filters = [
      guest ? `guest "${guest}"` : null,
      month ? MONTH_NAMES[month - 1] : null,
      year ? String(year) : null,
    ].filter(Boolean);
    return `No episodes found${filters.length ? ` for ${filters.join(' ')}` : ''}.`;
  }

  const filterDesc = [
    guest ? `with ${guest}` : null,
    month ? MONTH_NAMES[month - 1] : null,
    year ? String(year) : null,
  ]
    .filter(Boolean)
    .join(' ');

  const totalNote = meta.episode_count ? ` (${meta.episode_count} total in archive)` : '';
  const paginationNote =
    offset > 0 || episodes.length === limit
      ? `\nShowing ${offset + 1}–${offset + episodes.length}${totalNote}`
      : `\n${episodes.length} episode(s)${totalNote}`;

  const header = `## Entra.Chat Podcast Archive${filterDesc ? ` — ${filterDesc}` : ''}${paginationNote}\n\n`;
  const lastUpdated = meta.last_updated
    ? `*Last updated: ${new Date(meta.last_updated).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })}*\n\n`
    : '';

  const rows = episodes.map(formatEpisodeRow).join('\n');
  return `${header}${lastUpdated}\`\`\`\n${rows}\n\`\`\``;
}
