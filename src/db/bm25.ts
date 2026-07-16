import { tokenize } from '../utils/tokenize.js';

/**
 * In-memory BM25 index over transcript chunks.
 *
 * node:sqlite is compiled without FTS5 (nodejs/node#56951), so instead of an
 * FTS5 virtual table the keyword layer is a plain inverted index built at
 * startup — the same pattern the embedding cache uses for the vector layer.
 * The corpus is small (a few thousand chunks), so build time is well under a
 * second and memory is a few MB.
 */

const K1 = 1.2;
const B = 0.75;

export interface Bm25Hit {
  chunk_id: number;
  score: number;
}

export class Bm25Index {
  /** term → (chunk_id → term frequency) */
  private postings = new Map<string, Map<number, number>>();
  /** chunk_id → document length in tokens */
  private docLen = new Map<number, number>();
  private avgdl = 0;

  get size(): number {
    return this.docLen.size;
  }

  build(docs: Array<{ id: number; text: string }>): void {
    this.postings.clear();
    this.docLen.clear();

    let totalLen = 0;
    for (const doc of docs) {
      const tokens = tokenize(doc.text);
      this.docLen.set(doc.id, tokens.length);
      totalLen += tokens.length;

      for (const term of tokens) {
        let posting = this.postings.get(term);
        if (!posting) {
          posting = new Map<number, number>();
          this.postings.set(term, posting);
        }
        posting.set(doc.id, (posting.get(doc.id) ?? 0) + 1);
      }
    }

    this.avgdl = docs.length > 0 ? totalLen / docs.length : 0;
  }

  search(query: string, limit: number): Bm25Hit[] {
    const terms = tokenize(query);
    if (terms.length === 0 || this.docLen.size === 0) return [];

    const N = this.docLen.size;
    const scores = new Map<number, number>();

    for (const term of terms) {
      const posting = this.postings.get(term);
      if (!posting) continue;

      const df = posting.size;
      const idf = Math.log(1 + (N - df + 0.5) / (df + 0.5));

      for (const [chunkId, tf] of posting) {
        const len = this.docLen.get(chunkId) ?? 0;
        const denom = tf + K1 * (1 - B + (B * len) / this.avgdl);
        const contribution = (idf * tf * (K1 + 1)) / denom;
        scores.set(chunkId, (scores.get(chunkId) ?? 0) + contribution);
      }
    }

    return [...scores.entries()]
      .map(([chunk_id, score]) => ({ chunk_id, score }))
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
  }
}
