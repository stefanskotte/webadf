import { describe, it, expect } from 'vitest';
import { matchHelpTopics, filterHelpTopics } from './match';

// Header search's Help group (A3): help topics found by title and short description, in the browser.
describe('matchHelpTopics', () => {
  it('finds a topic by a word of its title, case aside', () => {
    expect(matchHelpTopics('PRELOAD')).toContain('next-disk');
  });
  it('finds a topic by its short description', () => {
    // "ahead of time" is in next-disk's short text, not its title.
    expect(matchHelpTopics('ahead of time')).toEqual(['next-disk']);
  });
  it('needs every word, in any order', () => {
    expect(matchHelpTopics('preloading next')).toContain('next-disk');
    expect(matchHelpTopics('preloading zebra')).toEqual([]);
  });
  it('puts title matches before description matches, and gives at most three', () => {
    const hits = matchHelpTopics('disk');
    expect(hits.length).toBeLessThanOrEqual(3);
    expect(hits[0]).toMatch(/disk/);   // a topic whose id -- and title -- names disks
  });
  it('nothing for a blank or one-letter query', () => {
    expect(matchHelpTopics('')).toEqual([]);
    expect(matchHelpTopics('  ')).toEqual([]);
    expect(matchHelpTopics('a')).toEqual([]);
  });
});

describe('filterHelpTopics (C5 spec §3.4, Ruling 15)', () => {
  it('is inactive under two characters, and filters nothing', () => {
    expect(filterHelpTopics('')).toEqual({ active: false, ids: new Set() });
    expect(filterHelpTopics(' d ').active).toBe(false);
  });
  it('matches every word in title or short text, with no limit', () => {
    // e2e/c5-layout.spec.ts's filter test relies on this exact set.
    expect(filterHelpTopics('drive')).toEqual({ active: true, ids: new Set(['second-drive', 'boards', 'network', 'send']) });
    expect(filterHelpTopics('disk').ids.size).toBeGreaterThan(3);   // more than the header's three
  });
  it('active with no match is a real answer: zero topics', () => {
    expect(filterHelpTopics('zzqx')).toEqual({ active: true, ids: new Set() });
  });
});
