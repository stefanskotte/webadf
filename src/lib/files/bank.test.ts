import { describe, it, expect } from 'vitest';
import { BANK_GRID, BANK_LABEL } from './bank';

describe('the button bank (Files 2 §2.3)', () => {
  it('is six columns by three rows in the spec\'s order, one empty cell before Delete', () => {
    const label = (c: (typeof BANK_GRID)[number]) => (c === null ? '' : BANK_LABEL[c]);
    expect(BANK_GRID).toHaveLength(18);
    expect(BANK_GRID.slice(0, 6).map(label)).toEqual(['All', 'Copy', 'Makedir', 'Create ADF…', 'Info', 'Download']);
    expect(BANK_GRID.slice(6, 12).map(label)).toEqual(['None', 'Move', 'Rename', 'Add to library', 'Protect', 'Filter…']);
    expect(BANK_GRID.slice(12).map(label)).toEqual(['Parent', 'Root', 'Swap', 'Show .info', '', 'Delete']);
  });
  it('carries no arrows', () => {
    expect(Object.values(BANK_LABEL).join(' ')).not.toMatch(/[→←⇄]/);
  });
});
