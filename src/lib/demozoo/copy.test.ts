import { describe, it, expect } from 'vitest';
import { decodeCopyField, parseCopyHeader, readCopyBlocks, type CopyRow } from './copy';
import { textLines } from './lines';

describe('decodeCopyField', () => {
  it('reads \\N as null', () => expect(decodeCopyField('\\N')).toBeNull());
  it('leaves plain text alone', () => expect(decodeCopyField('9 Fingers')).toBe('9 Fingers'));
  it('decodes backslash escapes', () => {
    expect(decodeCopyField('a\\tb\\nc\\\\d')).toBe('a\tb\nc\\d');
    expect(decodeCopyField('\\r\\b\\f\\v')).toBe('\r\b\f\v');
  });
  it('decodes octal and hex escapes', () => {
    expect(decodeCopyField('\\101\\x42')).toBe('AB');
  });
  it('keeps an empty string distinct from null', () => expect(decodeCopyField('')).toBe(''));
});

describe('parseCopyHeader', () => {
  it('reads table and columns, stripping public. and quotes', () => {
    expect(parseCopyHeader('COPY public.productions_productiontype (id, name, "position") FROM stdin;'))
      .toEqual({ table: 'productions_productiontype', columns: ['id', 'name', 'position'] });
  });
  it('ignores anything that is not a COPY header', () => {
    expect(parseCopyHeader('SET client_encoding = \'UTF8\';')).toBeNull();
  });
});

describe('readCopyBlocks', () => {
  const dump = [
    'SET statement_timeout = 0;',
    'COPY public.platforms_platform (id, name) FROM stdin;',
    '5\tAmiga OCS/ECS',
    '1\tZX Spectrum',
    '\\.',
    'COPY public.unwanted_table (id, text) FROM stdin;',
    'COPY public.platforms_platform (id, name) FROM stdin;',   // a data line that LOOKS like a header
    '\\.',
    'COPY public.productions_production (id, title, notes) FROM stdin;',
    '89\t9 Fingers\t\\N',
    '\\.',
  ].join('\n');

  it('yields only rows of wanted tables, keyed by column', async () => {
    const rows: CopyRow[] = [];
    for await (const r of readCopyBlocks(textLines(dump), new Set(['platforms_platform', 'productions_production']))) {
      rows.push(r);
    }
    expect(rows).toEqual([
      { table: 'platforms_platform', row: { id: '5', name: 'Amiga OCS/ECS' } },
      { table: 'platforms_platform', row: { id: '1', name: 'ZX Spectrum' } },
      { table: 'productions_production', row: { id: '89', title: '9 Fingers', notes: null } },
    ]);
  });
});
