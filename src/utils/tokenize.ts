import { stem } from './porter.js';

/**
 * Shared tokeniser for the BM25 index and queries. The same pipeline must be
 * applied to both sides or terms will never match: lowercase → strip
 * non-alphanumerics → drop short tokens and stopwords → Porter stem.
 *
 * The stopword list includes spoken-word fillers because the corpus is
 * podcast transcripts, not prose.
 */
const STOPWORDS = new Set([
  // standard English
  'the', 'a', 'an', 'and', 'or', 'but', 'of', 'to', 'in', 'on', 'at', 'for',
  'with', 'by', 'from', 'as', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
  'it', 'its', 'this', 'that', 'these', 'those', 'i', 'you', 'he', 'she', 'we',
  'they', 'them', 'his', 'her', 'their', 'our', 'your', 'my', 'me', 'us',
  'do', 'does', 'did', 'have', 'has', 'had', 'will', 'would', 'can', 'could',
  'should', 'shall', 'may', 'might', 'not', 'no', 'so', 'if', 'then', 'than',
  'there', 'here', 'what', 'which', 'who', 'when', 'where', 'how', 'why',
  'all', 'any', 'some', 'just', 'about', 'into', 'out', 'up', 'down', 'over',
  'again', 'also', 'very', 'more', 'most', 'other', 'because', 'get', 'got',
  // spoken-word fillers common in podcast transcripts
  'um', 'uh', 'like', 'know', 'yeah', 'gonna', 'wanna', 'kind', 'sort',
  'really', 'actually', 'basically', 'right', 'okay', 'ok', 'well', 'mean',
  'thing', 'things', 'stuff', 'going', 'go', 'say', 'said',
]);

export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .split(' ')
    .filter((t) => t.length >= 2 && !STOPWORDS.has(t))
    .map(stem);
}
