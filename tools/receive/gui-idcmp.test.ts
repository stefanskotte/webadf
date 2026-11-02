import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

// The window code only runs on an Amiga, so this guards the one flag that stopped copies (A500 bench 2026-11-02):
// LISTVIEWIDCMP brings INTUITICKS, sent only to the active window, and a copy stopped while Transfer's window was active.
describe("Transfer's window", () => {
  it('never asks for Intuition ticks, which LISTVIEWIDCMP would bring', () => {
    const gui = fs.readFileSync(path.join(import.meta.dirname, 'amiga/gui.c'), 'utf8');
    const idcmp = gui.split('\n').filter((l) => l.includes('WA_IDCMP'));
    expect(idcmp).toHaveLength(1);
    expect(idcmp[0]).toContain('LISTVIEWIDCMP');
    expect(idcmp[0]).toContain('& ~IDCMP_INTUITICKS');
  });
});
