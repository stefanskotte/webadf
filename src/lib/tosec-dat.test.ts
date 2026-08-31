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

describe('parseDat (Regression: 100+ games with cross-game mis-association check)', () => {
  // Helper to generate test fixtures programmatically with paren-heavy names
  const generateGames = (count: number) => {
    const games: Array<{ name: string; crc: string; md5: string; sha1: string }> = [];
    for (let i = 0; i < count; i++) {
      // Paren-heavy, TOSEC-realistic name with nested parens to exercise edge cases
      const name = `Game ${i} (199${i % 10})(Publisher (Sub) Ltd)(PD)[cr CSL][a1]`;
      // Derive distinct hashes from index - detectable if swapped
      const crc = i.toString(16).padStart(8, '0');
      const md5 = i.toString(16).padStart(32, '0');
      const sha1 = i.toString(16).padStart(40, '0');
      games.push({ name, crc, md5, sha1 });
    }
    return games;
  };

  const generateCmp = (games: Array<{ name: string; crc: string; md5: string; sha1: string }>) => {
    let cmp = `clrmamepro (
\tname "Test Set"
\tversion 1.0
)
`;
    for (const game of games) {
      cmp += `
game (
\tname "${game.name}"
\trom ( name "${game.name}.adf" size 901120 crc ${game.crc} md5 ${game.md5} sha1 ${game.sha1} )
)
`;
    }
    return cmp;
  };

  const generateXml = (games: Array<{ name: string; crc: string; md5: string; sha1: string }>) => {
    let xml = `<?xml version="1.0"?>
<datafile>
\t<header><name>Test Set</name><version>1.0</version></header>
`;
    for (const game of games) {
      xml += `\t<game name="${game.name}">
\t\t<rom name="${game.name}.adf" size="901120" crc="${game.crc}" md5="${game.md5}" sha1="${game.sha1}"/>
\t</game>
`;
    }
    xml += `</datafile>`;
    return xml;
  };

  it('handles 150 games without cross-game mis-association (ClrMamePro)', () => {
    const games = generateGames(150);
    const cmp = generateCmp(games);
    const dat = parseDat(cmp);

    // Assert entry count equals game count
    expect(dat.entries).toHaveLength(games.length);

    // Assert each entry's hash matches its game's hash (detects rom clause bleeding)
    for (let i = 0; i < games.length; i++) {
      const entry = dat.entries[i];
      const game = games[i];
      expect(entry.crc32).toBe(game.crc.toLowerCase());
      expect(entry.md5).toBe(game.md5.toLowerCase());
      expect(entry.sha1).toBe(game.sha1.toLowerCase());
      expect(entry.gameName).toBe(game.name);
    }
  });

  it('handles 150 games without cross-game mis-association (Logiqx XML)', () => {
    const games = generateGames(150);
    const xml = generateXml(games);
    const dat = parseDat(xml);

    // Assert entry count equals game count
    expect(dat.entries).toHaveLength(games.length);

    // Assert each entry's hash matches its game's hash (detects rom clause bleeding)
    for (let i = 0; i < games.length; i++) {
      const entry = dat.entries[i];
      const game = games[i];
      expect(entry.crc32).toBe(game.crc.toLowerCase());
      expect(entry.md5).toBe(game.md5.toLowerCase());
      expect(entry.sha1).toBe(game.sha1.toLowerCase());
      expect(entry.gameName).toBe(game.name);
    }
  });
});
