import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ratio } from '@/lib/contrast.test-util';

// Pins the Phase B palette (spec docs/superpowers/specs/2026-10-24-phase-b-foundation-design.md §4) as it is WRITTEN
// in globals.css, and the §4.5 contrast pairs that must clear WCAG AA (4.5:1 for text).
const css = readFileSync(join(process.cwd(), 'src/app/globals.css'), 'utf8');

/** The LAST hex value per custom property (the webadf :root block overrides shadcn's). */
function tokens(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of css.matchAll(/(--[a-z0-9-]+):\s*(#[0-9a-fA-F]{6})\b/g)) out[m[1]] = m[2].toUpperCase();
  return out;
}
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
    ['--ring', '#7A7262'],
    ['--fw-line', '#F1D3A4'],
    ['--modal-foot', '#FBF8F1'],
    ['--dash', '#C4B9A2'], ['--to-amiga-bg', '#DCE8F5'],
    ['--from-amiga-bg', '#E5F0DF'], ['--from-amiga-fg', '#2C5E24'], ['--accent-blue', '#1D4F86'],
    ['--dir-bg', '#E9EEF4'], ['--exe-bg', '#E2F0DF'], ['--exe-fg', '#2E5B2A'], ['--viewing-bg', '#FBF3E3'],
    ['--warning-line', '#E2C48F'], ['--on-ink-fill', '#3E3B36'],
    ['--danger-line', '#F2C9BF'], ['--danger-strong', '#9A2A1C'], ['--prose', '#3E392F'], ['--on-ink-2', '#E8E1D2'],
    ['--on-ink-muted', '#A39B8B'], ['--on-ink-accent', '#EE8A2A'],
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
    // Devices spec §12
    ['--muted', '--danger-bg'], ['--ink', '--danger-bg'], ['--muted', '--track'], ['--muted-2', '--modal-foot'],
    ['--surface', '--ink'],
    // Upload spec §8
    ['--accent-blue', '--to-amiga-bg'], ['--from-amiga-fg', '--from-amiga-bg'],
    ['--success-fg', '--surface'], ['--success-fg', '--modal-foot'], ['--warning-fg', '--surface'],
    ['--warning-fg', '--modal-foot'], ['--muted', '--modal-foot'], ['--danger-fg', '--modal-foot'],
    ['--ink', '--surface-2'], ['#FFFFFF', '--danger-fg'],
    // Disk files spec §11
    ['--accent-blue', '--dir-bg'], ['--exe-fg', '--exe-bg'], ['--warning-fg', '--warning-bg'],
    ['--success-fg', '--success-bg'], ['--danger-fg', '--danger-bg'], ['--muted-2', '--modal-foot'],
    ['--amber-text', '--surface-2'], ['--amber-text', '--viewing-bg'], ['--ink', '--viewing-bg'],
    ['--muted-2', '--viewing-bg'], ['--surface', '--on-ink-fill'], ['--fetch-dot', '--ink'], ['--danger-fg', '--surface'],
    // Settings / Help / Search / Sign in spec §11
    ['--ink', '--surface-2'], ['--muted', '--ground'], ['--muted', '--surface-2'], ['--muted-2', '--surface'],
    ['--muted-2', '--ground'], ['--success-fg', '--surface'], ['--danger-fg', '--ground'], ['--danger-fg', '--track'],
    ['--danger-strong', '--surface'], ['--danger-strong', '--danger-bg'], ['--prose', '--surface'],
    ['--on-ink-2', '--ink'], ['--on-ink-accent', '--ink'], ['--on-ink-muted', '--ink'],
  ];
  it.each(pairs)('%s on %s clears AA (4.5:1)', (fg, bg) => {
    const read = (n: string) => (n.startsWith('#') ? n : tok(n));
    expect(ratio(read(fg), read(bg))).toBeGreaterThanOrEqual(4.5);
  });

  // Focus indicators are non-text: WCAG 1.4.11 wants 3:1 against what they are drawn on. Only the FULL --ring
  // clears it (globals.css' base outline, Button's ring); at /50 it blends to ~2:1 on the surface, which
  // contrast.spec's focus test measures on the page.
  it.each(grounds)('--ring on %s clears 3:1 (WCAG 1.4.11)', (bg) => {
    expect(ratio(tok('--ring'), tok(bg))).toBeGreaterThanOrEqual(3);
  });

  // The switch's off track border is the non-text indicator of "off" (C5 spec §11): 3:1 on the card.
  it('--muted-2 (the switch\'s off border) clears 3:1 on --surface', () => {
    expect(ratio(tok('--muted-2'), tok('--surface'))).toBeGreaterThanOrEqual(3);
  });
  it('--search-scrim is the 12 % ink scrim (C5 spec §1.5)', () => {
    expect(css).toMatch(/--search-scrim:\s*rgb\(36 33 27 \/ 0\.12\)/);
  });

  it('no gradient token remains', () => {
    expect(css).not.toMatch(/--grad-/);
  });

  it('--accent stays shadcn\'s menu highlight, never the rust accent', () => {
    expect(tokens()['--accent']).toBe('#F6F2E9');
  });
});
