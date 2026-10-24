import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// Pins the Phase B palette (spec docs/superpowers/specs/2026-10-24-phase-b-foundation-design.md §4) as it is WRITTEN
// in globals.css, and the §4.5 contrast pairs that must clear WCAG AA (4.5:1 for text).
const css = readFileSync(join(process.cwd(), 'src/app/globals.css'), 'utf8');

/** The LAST hex value per custom property (the webadf :root block overrides shadcn's). */
function tokens(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of css.matchAll(/(--[a-z0-9-]+):\s*(#[0-9a-fA-F]{6})\b/g)) out[m[1]] = m[2].toUpperCase();
  return out;
}
function lum(hex: string) {
  const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map((x) => (x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4));
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
}
const ratio = (a: string, b: string) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };

/** A token's value, failing loudly (not with NaN) when the token is missing or not a hex. */
function tok(name: string): string {
  const v = tokens()[name];
  if (!v) throw new Error(`${name} is not set as a #rrggbb hex in globals.css`);
  return v;
}

describe('design tokens (globals.css)', () => {
  it.each([
    ['--ground', '#F3EFE6'],
    ['--surface', '#FFFDF8'],
    ['--surface-2', '#F6F2E9'],
    ['--track', '#EFE9DD'],
    ['--line', '#E4DCCB'],
    ['--line-strong', '#D3C8B2'],
    ['--ink', '#24211B'],
    ['--foreground', '#24211B'],
    ['--muted', '#5B5446'],
    ['--muted-2', '#6E6657'],
    ['--faint', '#6E6657'],
    ['--on-dark', '#24211B'],
    ['--on-dark-muted', '#5B5446'],
    ['--primary-action', '#24211B'],
    ['--accent-amber', '#B5541A'],
    ['--amber-text', '#A84C16'],
    ['--danger-fg', '#B3341F'],
    ['--success-fg', '#1F6A2A'],
    ['--warning-fg', '#7A4A08'],
    ['--online-dot', '#3FBF55'],
  ])('%s is %s', (name, value) => {
    expect(tokens()[name]).toBe(value);
  });

  const grounds = ['--surface', '--ground', '--surface-2', '--track'];
  const pairs: Array<[fg: string, bg: string]> = [
    ['--ink', '--ground'], ['--ink', '--surface'], ['--ink', '--track'],
    ...grounds.map((g): [string, string] => ['--muted', g]),
    ...grounds.map((g): [string, string] => ['--muted-2', g]),
    ...grounds.map((g): [string, string] => ['--faint', g]),
    ...grounds.map((g): [string, string] => ['--amber-text', g]),
    ['--accent-amber', '--surface'],
    ['#FFFFFF', '--accent-amber'], ['#FFFFFF', '--primary-action'], ['#FFFFFF', '--danger-fg'],
    ['--danger-fg', '--surface'], ['--danger-fg', '--danger-bg'],
    ['--success-fg', '--success-bg'],
    ['--warning-fg', '--warning-bg'],
  ];
  it.each(pairs)('%s on %s clears AA (4.5:1)', (fg, bg) => {
    const read = (n: string) => (n.startsWith('#') ? n : tok(n));
    expect(ratio(read(fg), read(bg))).toBeGreaterThanOrEqual(4.5);
  });

  it('no gradient token remains', () => {
    expect(css).not.toMatch(/--grad-/);
  });

  it('--accent stays shadcn\'s menu highlight, never the rust accent', () => {
    expect(tokens()['--accent']).toBe('#F6F2E9');
  });
});
