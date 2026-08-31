import { describe, it, expect } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { deflateSync } from 'node:zlib';
import { readFileSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { readOpenRetroDb } from './openretro-db';

/** 16-byte BLOB, as the real file stores uuids. */
function uuidBlob(hyphenated: string): Buffer {
  return Buffer.from(hyphenated.replace(/-/g, ''), 'hex');
}

function buildFixture(): Uint8Array {
  const dir = mkdtempSync(join(tmpdir(), 'oagd-'));
  const path = join(dir, 'Amiga.sqlite');
  const db = new DatabaseSync(path);
  db.exec('create table game (id integer primary key, uuid blob, data blob)');
  db.exec('create table metadata (version integer, games_version integer, database_version integer)');
  db.prepare('insert into metadata values (?, ?, ?)').run(19, 0, 17);

  const parentUuid = 'dd6a826f-7106-55d3-9503-435bdb6a2e9c';
  const parent = {
    _type: '1', game_name: 'Pinball Fantasies [AGA]', __link_name: 'pinball-fantasies-aga',
    publisher: '21st Century', developer: 'Digital Illusions', year: 1993,
    languages: 'en', players: '1 - 8 (1)', tags: 'pinball, scrolling',
    front_sha1: 'a'.repeat(40), title_sha1: 'b'.repeat(40),
    screen1_sha1: 'c'.repeat(40), screen2_sha1: 'd'.repeat(40),
    // 6-8 carry a `__` prefix upstream; 3 is absent, so ordering is also tested.
    __screen6_sha1: 'e'.repeat(40),
    hol_url: 'http://hol.abime.net/1056',
    description: 'A pinball simulation.',
    __long_description: 'Four tables, each with its own ruleset and multiball.',
    mobygames_url: 'http://www.mobygames.com/game/amiga/pinball-fantasies',
  };
  const variant = {
    _type: '2', parent_uuid: parentUuid, chipset: 'AGA', video_standard: 'NTSC',
    protection: 'Manual', variant_name: 'IPF, AGA, US, 2025',
    __source: 'Commodore Amiga - Games - SPS',
    file_list: JSON.stringify([
      { name: 'PF1.adf', sha1: '1'.repeat(40) },
      { name: 'PF2.adf', sha1: '2'.repeat(40) },
    ]),
  };

  const ins = db.prepare('insert into game (uuid, data) values (?, ?)');
  ins.run(uuidBlob(parentUuid), deflateSync(Buffer.from(JSON.stringify(parent))));
  ins.run(uuidBlob('11111111-2222-3333-4444-555555555555'), deflateSync(Buffer.from(JSON.stringify(variant))));
  ins.run(uuidBlob('99999999-9999-9999-9999-999999999999'), Buffer.alloc(0)); // the empty row
  db.close();
  return readFileSync(path);
}

describe('readOpenRetroDb', () => {
  const data = readOpenRetroDb(buildFixture());

  it('reads the metadata version', () => {
    expect(data.version).toBe(19);
  });

  it('separates parents from variants by _type', () => {
    expect(data.games).toHaveLength(1);
    expect(data.variants).toHaveLength(1);
  });

  it('inflates zlib-deflate, not gzip', () => {
    // The whole point: a gunzip-based reader throws on this data.
    expect(data.games[0].gameName).toBe('Pinball Fantasies [AGA]');
  });

  it('converts the uuid BLOB to the hyphenated form parent_uuid uses', () => {
    // If this is wrong, every variant silently orphans and nothing ever matches.
    expect(data.games[0].uuid).toBe('dd6a826f-7106-55d3-9503-435bdb6a2e9c');
    expect(data.variants[0].parentUuid).toBe('dd6a826f-7106-55d3-9503-435bdb6a2e9c');
  });

  it('extracts every sha1 from file_list, lowercased', () => {
    expect(data.variants[0].fileSha1s).toEqual(['1'.repeat(40), '2'.repeat(40)]);
  });

  it('collects screenshots in order and skips absent ones', () => {
    // Includes the __-prefixed sixth: 415 games in the real file carry
    // __screen6_sha1, and reading only `screen6_sha1` drops them silently.
    expect(data.games[0].screenshotSha1s).toEqual(['c'.repeat(40), 'd'.repeat(40), 'e'.repeat(40)]);
  });

  it('discriminates _type as a string, as the real file stores it', () => {
    // The real Amiga.sqlite stores "1"/"2", never 1/2. A numeric comparison
    // matches nothing at all: measured 0 games from a 21,440-row file.
    expect(data.games[0].uuid).toBe('dd6a826f-7106-55d3-9503-435bdb6a2e9c');
    expect(data.variants[0].chipset).toBe('AGA');
  });

  it('also tolerates a numeric _type', () => {
    const dir = mkdtempSync(join(tmpdir(), 'oagd-num-'));
    const path = join(dir, 'n.sqlite');
    const db = new DatabaseSync(path);
    db.exec('create table game (id integer primary key, uuid blob, data blob)');
    db.prepare('insert into game (uuid, data) values (?, ?)').run(
      uuidBlob('dd6a826f-7106-55d3-9503-435bdb6a2e9c'),
      deflateSync(Buffer.from(JSON.stringify({ _type: 1, game_name: 'Numeric' }))),
    );
    db.close();
    expect(readOpenRetroDb(readFileSync(path)).games[0].gameName).toBe('Numeric');
  });

  it('keeps the outbound links, including hol_url', () => {
    // hol_url is why the deferred Hall of Light increment needs no title matching.
    expect(data.games[0].holUrl).toBe('http://hol.abime.net/1056');
    expect(data.games[0].wikipediaUrl).toBeNull();
  });

  it('carries the parent fields that fill genre and chipset', () => {
    expect(data.games[0].tags).toBe('pinball, scrolling');
    expect(data.variants[0].chipset).toBe('AGA');
  });

  it('keeps both prose fields, the long one under its __ prefix', () => {
    // 1,706 games in the real file carry prose; the catalog prefers the long
    // form, so losing __long_description would quietly halve what it can show.
    expect(data.games[0].description).toBe('A pinball simulation.');
    expect(data.games[0].longDescription).toBe('Four tables, each with its own ruleset and multiball.');
  });

  it('skips a row with empty data rather than throwing', () => {
    expect(data.games.length + data.variants.length).toBe(2);
  });
});
