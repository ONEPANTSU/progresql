/**
 * Unit tests for the low-level string similarity helpers that drive
 * rename detection. Keeping these in a dedicated file makes it obvious
 * where to look when a rename-detection regression shows up.
 */

import {
  levenshtein,
  similarity,
  normaliseIdent,
  bestMatches,
} from '@/features/database-browser/schema-sync/util/similarity';

describe('levenshtein', () => {
  it('returns 0 for identical strings', () => {
    expect(levenshtein('abc', 'abc')).toBe(0);
    expect(levenshtein('', '')).toBe(0);
  });

  it('returns the length of the other string when one is empty', () => {
    expect(levenshtein('', 'abc')).toBe(3);
    expect(levenshtein('abc', '')).toBe(3);
  });

  it('counts single-char edits correctly', () => {
    expect(levenshtein('kitten', 'sitting')).toBe(3);
    expect(levenshtein('flaw', 'lawn')).toBe(2);
  });

  it('is symmetric', () => {
    expect(levenshtein('cat', 'cart')).toBe(levenshtein('cart', 'cat'));
  });
});

describe('similarity', () => {
  it('returns 1 for identical strings', () => {
    expect(similarity('order_status', 'order_status')).toBe(1);
  });

  it('returns 0 for fully different strings', () => {
    expect(similarity('abc', 'xyz')).toBeCloseTo(0, 5);
  });

  it('produces high scores for near-identical names', () => {
    expect(similarity('status', 'statuses')).toBeGreaterThan(0.7);
  });

  it('handles empty inputs', () => {
    expect(similarity('', '')).toBe(1);
    expect(similarity('', 'abc')).toBe(0);
  });
});

describe('normaliseIdent', () => {
  it('lowercases and strips non-word chars', () => {
    expect(normaliseIdent('Order_Status')).toBe('orderstatus');
    expect(normaliseIdent('   foo.BAR!  ')).toBe('foobar');
  });
});

describe('bestMatches', () => {
  it('pairs items greedily above the threshold', () => {
    const lefts = ['active', 'removed', 'brandnew'];
    const rights = ['activee', 'deleted', 'novel'];
    const result = bestMatches(lefts, rights, (x) => x, 0.55);
    // "active" should match "activee" strongly. "removed"/"deleted"
    // are weak. "brandnew"/"novel" shouldn't match.
    const pairs = result.map((r) => `${r.left}->${r.right}`);
    expect(pairs).toContain('active->activee');
  });

  it('never double-assigns a right-hand item', () => {
    const lefts = ['aaa', 'aab'];
    const rights = ['aac'];
    const result = bestMatches(lefts, rights, (x) => x, 0.3);
    // Only one of the two lefts can claim `aac`.
    expect(result.length).toBeLessThanOrEqual(1);
  });

  it('returns empty when nothing clears the threshold', () => {
    const lefts = ['foo'];
    const rights = ['zzzzz'];
    expect(bestMatches(lefts, rights, (x) => x, 0.8)).toEqual([]);
  });
});
