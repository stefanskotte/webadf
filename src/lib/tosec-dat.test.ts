import { describe, it, expect } from 'vitest';
import { parseDat } from './tosec-dat';

const CMP = `clrmamepro (
	name "Commodore Amiga - Games - [ADF]"
	description "Commodore Amiga - Games - [ADF] (TOSEC-v2024-01-01)"
	version 2024-01-01
)

game (
	name "State of the Art (1992)(Spaceballs)(PD)"
	description "State of the Art (1992)(Spaceballs)(PD)"
	rom ( name "State of the Art (1992)(Spaceballs)(PD).adf" size 901120 crc 1A2B3C4D md5 D41D8CD98F00B204E9800998ECF8427E sha1 DA39A3EE5E6B4B0D3255BFEF95601890AFD80709 )
)

game (
	name "Turrican II (1991)(Rainbow Arts)(Disk 2 of 3)"
	description "Turrican II (1991)(Rainbow Arts)(Disk 2 of 3)"
	rom ( name "Turrican II (1991)(Rainbow Arts)(Disk 2 of 3).adf" size 901120 crc DEADBEEF )
)
`;

const XML = `<?xml version="1.0"?>
<datafile>
  <header><name>Commodore Amiga - Games - [ADF]</name><version>2024-01-01</version></header>
  <game name="State of the Art (1992)(Spaceballs)(PD)">
    <rom name="State of the Art (1992)(Spaceballs)(PD).adf" size="901120" crc="1A2B3C4D" md5="D41D8CD98F00B204E9800998ECF8427E" sha1="DA39A3EE5E6B4B0D3255BFEF95601890AFD80709"/>
  </game>
</datafile>`;

describe('parseDat (ClrMamePro)', () => {
  it('reads the set name and version from the header', () => {
    const dat = parseDat(CMP);
    expect(dat.setName).toBe('Commodore Amiga - Games - [ADF]');
    expect(dat.setVersion).toBe('2024-01-01');
  });

  it('reads every game, not just the first', () => {
    expect(parseDat(CMP).entries).toHaveLength(2);
  });

  it('lowercases hashes so nothing downstream has to normalise', () => {
    const e = parseDat(CMP).entries[0];
    expect(e.crc32).toBe('1a2b3c4d');
    expect(e.md5).toBe('d41d8cd98f00b204e9800998ecf8427e');
    expect(e.sha1).toBe('da39a3ee5e6b4b0d3255bfef95601890afd80709');
  });

  it('leaves absent hashes null rather than empty strings', () => {
    // The second entry has crc only. A '' here would match a blob whose md5
    // was also '' -- null cannot be compared equal by accident.
    const e = parseDat(CMP).entries[1];
    expect(e.crc32).toBe('deadbeef');
    expect(e.md5).toBeNull();
    expect(e.sha1).toBeNull();
  });

  it('parses the game name through parseTosecName', () => {
    const e = parseDat(CMP).entries[0];
    expect(e.title).toBe('State of the Art');
    expect(e.year).toBe(1992);
    expect(e.publisher).toBe('Spaceballs');
    expect(e.sortTitle).toBe('state of the art');
  });

  it('carries the disk clause through', () => {
    const e = parseDat(CMP).entries[1];
    expect(e.title).toBe('Turrican II');
    expect(e.diskNo).toBe(2);
    expect(e.diskCount).toBe(3);
  });

  it('records the size, which the crc32 fallback depends on', () => {
    expect(parseDat(CMP).entries[0].sizeBytes).toBe(901120);
  });
});

describe('parseDat (Logiqx XML)', () => {
  it('produces the same entry from the XML form', () => {
    const x = parseDat(XML).entries[0];
    const c = parseDat(CMP).entries[0];
    expect(x.romName).toBe(c.romName);
    expect(x.sha1).toBe(c.sha1);
    expect(x.title).toBe(c.title);
    expect(x.year).toBe(c.year);
  });

  it('reads the header out of <header>', () => {
    expect(parseDat(XML).setName).toBe('Commodore Amiga - Games - [ADF]');
    expect(parseDat(XML).setVersion).toBe('2024-01-01');
  });
});

describe('parseDat robustness', () => {
  it('returns no entries for empty input rather than throwing', () => {
    expect(parseDat('').entries).toEqual([]);
  });

  it('skips a game with no rom line', () => {
    expect(parseDat('game (\n\tname "Nothing"\n)\n').entries).toEqual([]);
  });
});
