import { z } from 'zod';
import { findGuestsByName, getEpisodesForGuest } from '../db/client.js';
import { formatGuestLinks, formatTimestamp } from '../utils/format.js';

export const getGuestSchema = z.object({
  name: z
    .string()
    .min(1)
    .describe('Guest name to look up (case-insensitive; partial names match)'),
});

type GetGuestArgs = z.infer<typeof getGuestSchema>;

export function handleGetGuest(args: GetGuestArgs): string {
  const matches = findGuestsByName(args.name);

  if (matches.length === 0) {
    return `No guest found matching "${args.name}". Use list_guests to browse all guests.`;
  }

  if (matches.length > 1) {
    const candidates = matches.map((g) => `- ${g.name}`).join('\n');
    return `Multiple guests match "${args.name}" — please use a more specific name:\n\n${candidates}`;
  }

  const guest = matches[0];
  const episodes = getEpisodesForGuest(guest.id);
  const links = formatGuestLinks(guest);

  const episodeLines = episodes.map((e) => {
    const ref = e.episode_number != null ? `#${e.episode_number}` : '—';
    const date = new Date(e.published_at).toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    });
    const duration = e.duration_sec != null ? ` · ${formatTimestamp(e.duration_sec)}` : '';
    return `- ${ref} · [${e.title}](${e.url}) · ${date}${duration}`;
  });

  const parts = [
    `## ${guest.name}`,
    '',
    links ? `**Profiles:** ${links}` : null,
    guest.bio ? `**Bio:** ${guest.bio}` : null,
    '',
    `**Appearances (${episodes.length} episode${episodes.length === 1 ? '' : 's'}):**`,
    '',
    episodeLines.length > 0 ? episodeLines.join('\n') : '*No episodes recorded.*',
  ].filter((p): p is string => p !== null);

  return parts.join('\n');
}
