import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ratio } from '@/lib/contrast-test-util';
import { DISK_BODIES } from '@/lib/disk-icon';
import { collectionDot, COLLECTION_DOTS, kindTag, stageFor, titleDiskColor } from '@/lib/library-look';

// Spec docs/superpowers/specs/2026-10-24-phase-c1-library-title-design.md §4. The contrast maths is shared with the
// Phase B token test (src/lib/contrast-test-util.ts).
const css = readFileSync(join(process.cwd(), 'src/app/globals.css'), 'utf8');
function tok(name: string): string {
  const all = [...css.matchAll(new RegExp(`(${name}):\\s*(#[0-9a-fA-F]{6})\\b`, 'g'))];
  if (all.length === 0) throw new Error(`${name} is not set as a #rrggbb hex in globals.css`);
  return all[all.length - 1][2].toUpperCase();
}
const hexOf = (v: string) => (v.startsWith('var(') ? tok(v.slice(4, -1)) : v.toUpperCase());

describe('library tokens (globals.css)', () => {
  it.each([
    ['--mounted-bg', '#EEF6EC'], ['--mounted-line', '#9CCB98'], ['--drive-pill-bg', '#14201A'],
    ['--drive-pill-fg', '#9BEA9F'], ['--fetch-dot', '#E9A23B'],
  ])('%s is %s', (name, value) => { expect(tok(name)).toBe(value); });
});

describe('kindTag', () => {
  it('maps the three named kinds to the board colours', () => {
    expect(kindTag('Game')).toEqual({ bg: '#E1ECF8', fg: '#1D4A7A' });
    expect(kindTag('App')).toEqual({ bg: '#EEE5F5', fg: '#5A3380' });
    expect(kindTag('Demo')).toEqual({ bg: '#E2F0DF', fg: '#2E5B2A' });
  });
  it.each(['Educational', 'Coverdisk', '', 'whatever'])('%j falls back to track / muted', (k) => {
    expect(kindTag(k)).toEqual({ bg: 'var(--track)', fg: 'var(--muted)' });
  });
  it('takes null and undefined', () => {
    expect(kindTag(null)).toEqual(kindTag('Coverdisk'));
    expect(kindTag(undefined)).toEqual(kindTag('Coverdisk'));
  });
  it.each(['Game', 'App', 'Demo', 'Educational'])('%s clears AA (4.5:1)', (k) => {
    const { bg, fg } = kindTag(k);
    expect(ratio(hexOf(fg), hexOf(bg))).toBeGreaterThanOrEqual(4.5);
  });
});

describe('titleDiskColor', () => {
  const base = { id: 'g1', hasHd: false, kind: 'Game' as string | null };
  it('is grey for an HD title and for an HFE title', () => {
    expect(titleDiskColor({ ...base, hasHd: true })).toBe('grey');
    expect(titleDiskColor({ ...base, formats: ['adf', 'HFE'] })).toBe('grey');
    expect(titleDiskColor({ ...base, kind: null, formats: ['hfe'] })).toBe('grey');
  });
  it('is cream for an unknown, non-authored title', () => {
    expect(titleDiskColor({ ...base, kind: null })).toBe('cream');
    expect(titleDiskColor({ ...base, kind: null, authored: false })).toBe('cream');
  });
  it('is stable per id, and one of the four body colours, otherwise', () => {
    const c = titleDiskColor(base);
    expect(titleDiskColor({ ...base })).toBe(c);
    expect(['black', 'red', 'blue', 'green']).toContain(c);
    const seen = new Set(Array.from({ length: 200 }, (_, i) => titleDiskColor({ ...base, id: `id-${i}` })));
    expect([...seen].sort()).toEqual(['black', 'blue', 'green', 'red']);
  });
  it('treats an authored title with no kind like any other (not cream)', () => {
    expect(titleDiskColor({ ...base, kind: null, authored: true })).not.toBe('cream');
  });
});

describe('stageFor', () => {
  it('is the board map', () => {
    expect(stageFor('black')).toBe('#F1ECE2');
    expect(stageFor('blue')).toBe('#E9EEF4');
    expect(stageFor('grey')).toBe('#EEEDEA');
    expect(stageFor('red')).toBe('#F6E9E4');
    expect(stageFor('green')).toBe('#E8F0EA');
    expect(stageFor('cream')).toBe('#F4EFE5');
  });
  it('is total over every disk colour', () => {
    for (const c of Object.keys(DISK_BODIES) as Array<keyof typeof DISK_BODIES>) {
      expect(stageFor(c)).toMatch(/^#[0-9A-F]{6}$/);
    }
  });
});

describe('collectionDot', () => {
  it('is stable for a fixed id and one of the four logo stripes', () => {
    expect(collectionDot('abc')).toBe(collectionDot('abc'));
    expect(COLLECTION_DOTS).toEqual(['#D9453A', '#EE8A2A', '#4F9D4A', '#2F6FB5']);
    for (const id of ['', 'a', 'abc', '00000000-0000-0000-0000-000000000000', 'ü€']) {
      expect(COLLECTION_DOTS).toContain(collectionDot(id));
    }
  });
  it('uses all four stripes across many ids', () => {
    const seen = new Set(Array.from({ length: 200 }, (_, i) => collectionDot(`c-${i}`)));
    expect(seen.size).toBe(4);
  });
});
