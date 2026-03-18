import { createLogger } from './logger.js';
import type { Article } from './types.js';

const log = createLogger('dedup');

const SIMILARITY_THRESHOLD = 0.55;

// Common English stop words that don't carry meaning for comparison
const STOP_WORDS = new Set([
  'a', 'an', 'the', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for',
  'of', 'with', 'by', 'from', 'is', 'are', 'was', 'were', 'be', 'been',
  'has', 'have', 'had', 'do', 'does', 'did', 'will', 'would', 'could',
  'should', 'may', 'might', 'can', 'its', 'it', 'this', 'that', 'how',
  'what', 'which', 'who', 'whom', 'when', 'where', 'why', 'not', 'no',
  'new', 'says', 'said', 'just', 'about', 'into', 'over', 'after', 'up',
  'out', 'now', 'also', 'than', 'more', 'most', 'some', 'all', 'as',
]);

function normalizeTitle(title: string): Set<string> {
  const words = title
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')  // strip punctuation
    .split(/\s+/)
    .filter(w => w.length > 1 && !STOP_WORDS.has(w));
  return new Set(words);
}

function jaccardSimilarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 0;

  let intersection = 0;
  for (const word of a) {
    if (b.has(word)) intersection++;
  }

  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

/**
 * Removes cross-source duplicates from a list of articles.
 * When two articles from different sources cover the same story,
 * keeps the one with the longest snippet (most content).
 */
export function deduplicateArticles(articles: Article[]): Article[] {
  if (articles.length <= 1) return articles;

  const normalized = articles.map(a => ({
    article: a,
    words: normalizeTitle(a.title),
  }));

  // Track which articles are duplicates (index -> kept article index)
  const duplicateOf = new Map<number, number>();

  for (let i = 0; i < normalized.length; i++) {
    if (duplicateOf.has(i)) continue;

    for (let j = i + 1; j < normalized.length; j++) {
      if (duplicateOf.has(j)) continue;

      const similarity = jaccardSimilarity(normalized[i].words, normalized[j].words);
      if (similarity >= SIMILARITY_THRESHOLD) {
        // Keep the one with more content
        const keepI = normalized[i].article.snippet.length >= normalized[j].article.snippet.length;
        if (keepI) {
          duplicateOf.set(j, i);
        } else {
          duplicateOf.set(i, j);
          break; // i is now a duplicate, stop comparing it
        }

        log.info(
          `Duplicate detected (similarity: ${(similarity * 100).toFixed(0)}%): ` +
          `"${normalized[i].article.title}" [${normalized[i].article.source}] ~ ` +
          `"${normalized[j].article.title}" [${normalized[j].article.source}]`
        );
      }
    }
  }

  const result = articles.filter((_, idx) => !duplicateOf.has(idx));

  const removed = articles.length - result.length;
  if (removed > 0) {
    log.info(`Removed ${removed} cross-source duplicate(s) from ${articles.length} articles`);
  }

  return result;
}
