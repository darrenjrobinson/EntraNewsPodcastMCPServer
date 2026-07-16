import { z } from 'zod';
import { semanticSearch, keywordSearch, hasEmbeddings, SearchResult } from '../db/client.js';
import { getEmbedding } from '../utils/embeddings.js';
import { deepLink, formatDate, formatTimestamp } from '../utils/format.js';

// Each retrieval leg fetches more candidates than the final limit so that
// Reciprocal Rank Fusion has enough overlap to work with.
const CANDIDATES_PER_LEG = 50;
const RRF_K = 60;

export const searchSchema = z.object({
  query: z.string().min(1).describe('Natural language question or keywords to search for'),
  limit: z.number().int().min(1).max(50).default(10).describe('Maximum number of results to return'),
  mode: z
    .enum(['hybrid', 'semantic', 'keyword'])
    .default('hybrid')
    .describe('Search mode: hybrid (default), semantic-only, or keyword-only (BM25)'),
});

type SearchArgs = z.infer<typeof searchSchema>;

function formatResult(r: SearchResult, rank: number): string {
  const episodeRef = r.episode_number != null ? `Episode #${r.episode_number}` : 'Episode';
  const heading =
    r.section_heading && !r.section_heading.startsWith('<Untitled') ? ` › ${r.section_heading}` : '';
  const timestamp = r.start_time != null ? ` · [${formatTimestamp(r.start_time)}]` : '';
  const guests = r.guests ? ` · with ${r.guests}` : '';
  return [
    `**[${rank}] ${r.title}${heading}**`,
    `${episodeRef} · ${formatDate(r.published_at)}${guests}${timestamp}`,
    `Watch: ${deepLink(r.video_id, r.start_time)}`,
    '',
    r.text.trim(),
  ].join('\n');
}

/**
 * Reciprocal Rank Fusion (Cormack et al., 2009): score = Σ 1/(k + rank).
 * Merges the BM25 and vector rankings without score calibration.
 */
function rrfMerge(legs: SearchResult[][], limit: number): SearchResult[] {
  const scores = new Map<number, number>();
  const byId = new Map<number, SearchResult>();

  for (const leg of legs) {
    leg.forEach((result, rank) => {
      scores.set(result.chunk_id, (scores.get(result.chunk_id) ?? 0) + 1 / (RRF_K + rank + 1));
      if (!byId.has(result.chunk_id)) byId.set(result.chunk_id, result);
    });
  }

  return [...scores.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([chunkId], rank) => ({ ...byId.get(chunkId)!, distance: rank }));
}

export async function handleSearchEntraPodcasts(args: SearchArgs): Promise<string> {
  const { query, limit, mode } = args;
  const apiKey = process.env.OPENAI_API_KEY;
  const semanticAvailable = Boolean(apiKey) && hasEmbeddings();

  let semanticResults: SearchResult[] = [];
  let keywordResults: SearchResult[] = [];

  if (mode === 'semantic' && !semanticAvailable) {
    return !apiKey
      ? 'Semantic search requires the OPENAI_API_KEY environment variable. Use mode "keyword" (BM25) instead, or set the key.'
      : 'Semantic search is unavailable — the database contains no embeddings yet. Use mode "keyword" (BM25) instead.';
  }

  if (mode !== 'keyword' && semanticAvailable) {
    try {
      const embedding = await getEmbedding(query, apiKey!);
      semanticResults = semanticSearch(embedding, mode === 'semantic' ? limit : CANDIDATES_PER_LEG);
    } catch (err) {
      process.stderr.write(`[entra-news-podcast-mcp] Semantic search failed, falling back to keyword: ${err}\n`);
    }
  }

  if (mode !== 'semantic') {
    keywordResults = keywordSearch(query, mode === 'keyword' ? limit : CANDIDATES_PER_LEG);
  }

  if (semanticResults.length === 0 && keywordResults.length === 0) {
    return `No results found for "${query}". Try different keywords or a broader query.`;
  }

  let results: SearchResult[];
  if (mode === 'semantic') {
    results = semanticResults.slice(0, limit);
  } else if (mode === 'keyword') {
    results = keywordResults.slice(0, limit);
  } else {
    results = rrfMerge([keywordResults, semanticResults], limit);
  }

  const modeNote =
    mode === 'hybrid' && !semanticAvailable
      ? '\n> *(Keyword-only mode — set OPENAI_API_KEY for hybrid BM25 + semantic search)*\n'
      : '';
  const header = `## Search results for: "${query}"\n${modeNote}\nFound ${results.length} result(s):\n\n---\n\n`;

  const body = results.map((r, i) => formatResult(r, i + 1)).join('\n\n---\n\n');
  return header + body;
}
