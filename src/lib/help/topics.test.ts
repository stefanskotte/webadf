import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { HELP_TOPICS, HELP_ORDER, type HelpTopicId } from './topics';

const IDS: HelpTopicId[] = ['boards', 'nfc', 'next-disk', 'write-back', 'write-protect', 'disk-sets', 'hd-hfe', 'display'];
// Internal words a reader of the help should never meet (spec §5).
const BANNED = /\b(PSRAM|TBYB|poll|sha256|cursor|WPROT)\b/i;

// Sentence ends: . ! ? followed by a space or the end -- but not "e.g." / "i.e." or a number like "1.7".
function sentences(s: string): number {
  return s.split(/(?<!\be\.g|\bi\.e)[.!?](?=\s|$)/).filter((p) => p.trim().length > 0).length;
}

function bodyText(id: HelpTopicId): string {
  return renderToStaticMarkup(HELP_TOPICS[id].body as React.ReactElement)
    .replace(/<[^>]+>/g, ' ')
    .replace(/&[a-z#0-9]+;/gi, ' ');
}

describe('help topics', () => {
  it('has exactly the eight spec topics', () => {
    expect(Object.keys(HELP_TOPICS).sort()).toEqual([...IDS].sort());
  });

  it('lists every topic once in the table of contents', () => {
    expect([...HELP_ORDER].sort()).toEqual([...IDS].sort());
    expect(new Set(HELP_ORDER).size).toBe(HELP_ORDER.length);
  });

  for (const id of IDS) {
    it(`${id}: a title, a 1-2 sentence short, no internal words`, () => {
      const t = HELP_TOPICS[id];
      expect(t.title.trim().length).toBeGreaterThan(0);
      expect(sentences(t.short)).toBeGreaterThanOrEqual(1);
      expect(sentences(t.short)).toBeLessThanOrEqual(2);
      expect(t.short).not.toMatch(BANNED);
    });

    it(`${id}: a body of roughly 80-200 words, no internal words`, () => {
      const text = bodyText(id);
      const words = text.split(/\s+/).filter(Boolean).length;
      expect(words).toBeGreaterThanOrEqual(60);
      expect(words).toBeLessThanOrEqual(260);
      expect(text).not.toMatch(BANNED);
    });
  }
});

// Final review fixes (2026-10-05): claims that were wrong, incomplete or unverifiable.
describe('help topics say what the app really does', () => {
  it('nfc names the tag type that works (MIFARE Classic; NTAG stickers are refused)', () => {
    expect(HELP_TOPICS.nfc.short + bodyText('nfc')).toMatch(/MIFARE Classic/);
  });
  it('boards gives the setup network password and the Update + password step', () => {
    const b = bodyText('boards');
    expect(b).toMatch(/wififloppy/);
    expect(b).toMatch(/Update/);
    expect(b).toMatch(/password/);
  });
  it('write-protect makes no unconfirmed claim about prompts to click through', () => {
    expect(bodyText('write-protect')).not.toMatch(/click through|put the volume back/i);
  });
  it('next-disk ties "Saving, then disk N" to the Next-disk card, the only case that shows it', () => {
    const b = bodyText('next-disk');
    const sentence = b.split(/(?<=[.!?])\s+/).find((s) => s.includes('Saving, then disk'));
    if (sentence) expect(sentence).toMatch(/Next-disk card/);
  });
  it('hd-hfe says the board must be able to play HD', () => {
    expect(bodyText('hd-hfe')).toMatch(/boards? that can play HD/i);
  });
});
