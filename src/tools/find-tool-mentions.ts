import { z } from 'zod';
import { findToolMentions, ToolMention } from '../db/client.js';
import { deepLink, formatDate, formatTimestamp } from '../utils/format.js';

export const findToolMentionsSchema = z.object({
  query: z
    .string()
    .optional()
    .describe(
      'Optional search query — filter by tool name or keyword mentioned in episodes (e.g. "Maester", "PowerShell", "Conditional Access")'
    ),
  limit: z
    .number()
    .int()
    .min(1)
    .max(100)
    .default(20)
    .describe('Maximum number of tool mentions to return'),
});

type FindToolMentionsArgs = z.infer<typeof findToolMentionsSchema>;

function formatToolMention(t: ToolMention, rank: number): string {
  const episodeRef = t.episode_number != null ? `Episode #${t.episode_number}` : 'Entra.Chat';
  // id < 0 means this is a synthetic result from chunk fallback, not a proper tool_mentions row
  const isSynthetic = t.id < 0;
  const typeTag = isSynthetic ? '📄 Transcript mention' : '🔧 Known tool';
  const timestamp =
    t.start_time != null
      ? `\n**Hear it:** [${formatTimestamp(t.start_time)}] ${deepLink(t.video_id, t.start_time)}`
      : '';
  const contextLine = t.context ? `\n**Context:** ${t.context}` : '';

  return [
    `**[${rank}] ${t.tool_name}** · ${typeTag}`,
    `Mentioned in: [${t.episode_title}](${t.episode_url}) · ${episodeRef} · ${formatDate(t.published_at)}`,
    timestamp,
    contextLine,
  ]
    .filter((l) => l !== '')
    .join('\n');
}

export function handleFindToolMentions(args: FindToolMentionsArgs): string {
  const { query, limit } = args;
  const mentions = findToolMentions(query, limit);

  if (mentions.length === 0) {
    const qualifier = query ? ` mentioning "${query}"` : '';
    return `No content found${qualifier} in the archive.`;
  }

  const hasSynthetic = mentions.some((m) => m.id < 0);
  const header = query
    ? `## Entra.Chat mentions of "${query}"\n\n` +
      (hasSynthetic
        ? `_(No curated tool entries matched — showing episodes where this term appears in the transcript.)_\n\n`
        : '') +
      `Found ${mentions.length} result(s):\n\n---\n\n`
    : `## Community Tools Mentioned on Entra.Chat\n\n${mentions.length} mention(s):\n\n---\n\n`;

  const body = mentions.map((t, i) => formatToolMention(t, i + 1)).join('\n\n---\n\n');
  return header + body;
}
