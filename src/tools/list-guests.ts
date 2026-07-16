import { z } from 'zod';
import { listGuests, GuestSummary } from '../db/client.js';
import { formatGuestLinks } from '../utils/format.js';

export const listGuestsSchema = z.object({
  query: z
    .string()
    .optional()
    .describe('Optional filter — only guests whose name contains this text'),
  limit: z
    .number()
    .int()
    .min(1)
    .max(200)
    .default(50)
    .describe('Maximum guests to return'),
  offset: z
    .number()
    .int()
    .min(0)
    .default(0)
    .describe('Pagination offset'),
});

type ListGuestsArgs = z.infer<typeof listGuestsSchema>;

function formatGuestRow(g: GuestSummary, rank: number): string {
  const links = formatGuestLinks(g);
  const latest = g.latest_appearance
    ? new Date(g.latest_appearance).toLocaleDateString('en-US', {
        year: 'numeric',
        month: 'short',
        day: 'numeric',
      })
    : 'unknown';
  const appearances = `${g.episode_count} episode${g.episode_count === 1 ? '' : 's'}`;
  return [
    `**[${rank}] ${g.name}** · ${appearances} · latest: ${latest}`,
    links ? links : null,
  ]
    .filter(Boolean)
    .join('\n');
}

export function handleListGuests(args: ListGuestsArgs): string {
  const { query, limit, offset } = args;
  const guests = listGuests({ query, limit, offset });

  if (guests.length === 0) {
    return query
      ? `No guests found matching "${query}".`
      : 'No guests found in the archive.';
  }

  const header = query
    ? `## Entra.Chat guests matching "${query}"\n\n${guests.length} guest(s):\n\n`
    : `## Entra.Chat Podcast Guests\n\n${guests.length} guest(s) — use get_guest for a full episode list per guest:\n\n`;

  const body = guests.map((g, i) => formatGuestRow(g, offset + i + 1)).join('\n\n');
  return header + body;
}
