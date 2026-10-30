import { describe, it, expect } from 'vitest';
import { BANK_GRID, BANK_LABEL } from './bank';

describe('the button bank (Files 2 §2.3)', () => {
  it('is six columns by three rows in the spec\'s order', () => {
    const label = (c: (typeof BANK_GRID)[number]) => (c === null ? '' : BANK_LABEL[c]);
    expect(BANK_GRID).toHaveLength(18);
    expect(BANK_GRID.slice(0, 6).map(label)).toEqual(['All', 'Copy', 'Makedir', 'Create ADF…', 'Info', 'Download']);
    expect(BANK_GRID.slice(6, 12).map(label)).toEqual(['None', 'Move', 'Rename', 'Add to library', 'Protect', 'Filter…']);
    expect(BANK_GRID.slice(12).map(label)).toEqual(['Parent', 'Root', 'Swap', 'Show .info', 'Refresh', 'Delete']);
  });
  // NET: volumes (spec 2026-10-30 §5): row 3, column 5.
  it('Refresh takes the empty cell before Delete', () => {
    expect(BANK_GRID[16]).toBe('refresh');
    expect(BANK_GRID.filter((c) => c === null)).toHaveLength(0);
    expect(BANK_LABEL.refresh).toBe('Refresh');
  });
  it('carries no arrows', () => {
    expect(Object.values(BANK_LABEL).join(' ')).not.toMatch(/[→←⇄]/);
  });
});
