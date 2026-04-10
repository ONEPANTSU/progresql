/**
 * Lightweight string similarity helpers used by the rename detector.
 *
 * We deliberately avoid pulling in a dependency — Levenshtein distance is a
 * dozen lines of code and runs on tiny inputs (enum labels, identifiers),
 * so performance is a non-issue.
 */

/**
 * Classic Wagner–Fischer Levenshtein edit distance. O(|a|*|b|) time and
 * O(min(|a|,|b|)) space. Case-sensitive — callers normalise beforehand
 * when they want case-insensitive matching.
 */
export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;

  // Ensure `a` is the shorter string to keep the row buffer small.
  if (a.length > b.length) {
    const tmp = a; a = b; b = tmp;
  }

  const n = a.length;
  const m = b.length;
  const prev: number[] = new Array(n + 1);
  const curr: number[] = new Array(n + 1);

  for (let i = 0; i <= n; i++) prev[i] = i;

  for (let j = 1; j <= m; j++) {
    curr[0] = j;
    const bj = b.charCodeAt(j - 1);
    for (let i = 1; i <= n; i++) {
      const cost = a.charCodeAt(i - 1) === bj ? 0 : 1;
      curr[i] = Math.min(
        curr[i - 1] + 1,        // insertion
        prev[i] + 1,            // deletion
        prev[i - 1] + cost      // substitution
      );
    }
    for (let i = 0; i <= n; i++) prev[i] = curr[i];
  }

  return prev[n];
}

/**
 * Similarity in [0..1] derived from Levenshtein: `1 - distance/maxLen`.
 * Returns 1.0 for identical strings, 0.0 for completely different ones.
 */
export function similarity(a: string, b: string): number {
  if (a === b) return 1;
  const maxLen = Math.max(a.length, b.length);
  if (maxLen === 0) return 1;
  return 1 - levenshtein(a, b) / maxLen;
}

/**
 * Lower-case, strip non-word characters. Used for fuzzy match anchors —
 * `OrderStatus` and `order_status` should be treated as near-identical.
 */
export function normaliseIdent(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, '');
}

export interface MatchResult<T> {
  item: T;
  confidence: number;
}

/**
 * Greedy bipartite best-match: for every `left` element, find the unmatched
 * `right` element with the highest similarity that exceeds `threshold`.
 * Used by rename detection to pair "gone" source labels with "new" target
 * labels without double-assigning.
 */
export function bestMatches<L, R>(
  lefts: L[],
  rights: R[],
  key: (x: L | R) => string,
  threshold = 0.55,
): Array<{ left: L; right: R; confidence: number }> {
  const used = new Set<number>();
  const out: Array<{ left: L; right: R; confidence: number }> = [];

  for (const left of lefts) {
    let bestIdx = -1;
    let bestScore = 0;
    const leftKey = normaliseIdent(key(left));

    for (let i = 0; i < rights.length; i++) {
      if (used.has(i)) continue;
      const score = similarity(leftKey, normaliseIdent(key(rights[i])));
      if (score > bestScore) {
        bestScore = score;
        bestIdx = i;
      }
    }

    if (bestIdx >= 0 && bestScore >= threshold) {
      used.add(bestIdx);
      out.push({ left, right: rights[bestIdx], confidence: bestScore });
    }
  }

  return out;
}
