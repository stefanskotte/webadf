// Parses a TOSEC DAT into entry records. Pure: no database, no filesystem,
// no network -- so it is unit-testable, which matters because this is where
// a malformed set would otherwise become bad metadata for every tenant.
//
// TOSEC publishes both ClrMamePro and Logiqx-XML DATs and people download
// whichever they find, so both are accepted rather than making the operator
// care which one they got.

import { parseTosecName } from '@/lib/tosec';

export interface DatEntry {
  gameName: string; romName: string; sizeBytes: number;
  crc32: string | null; md5: string | null; sha1: string | null;
  title: string; sortTitle: string; year: number | null;
  publisher: string | null; diskNo: number | null; diskCount: number | null;
}

export interface DatFile { setName: string; setVersion: string | null; entries: DatEntry[] }

/** Absent stays null. '' would compare equal to another '' and match by accident. */
function hash(raw: string | undefined | null): string | null {
  const v = (raw ?? '').trim().toLowerCase();
  return v.length > 0 ? v : null;
}

function toEntry(gameName: string, romName: string, sizeBytes: number,
                 c: string | null, m: string | null, s: string | null): DatEntry {
  // The game name is a canonical TOSEC string -- which is the input
  // parseTosecName was written for, unlike the user filenames it normally sees.
  const p = parseTosecName(gameName.endsWith('.adf') ? gameName : `${gameName}.adf`);
  return {
    gameName, romName, sizeBytes,
    crc32: c, md5: m, sha1: s,
    title: p.title, sortTitle: p.sortTitle, year: p.year,
    publisher: p.publisher, diskNo: p.diskNo, diskCount: p.diskCount,
  };
}

function parseXml(text: string): DatFile {
  const setName = text.match(/<name>([^<]*)<\/name>/)?.[1]?.trim() ?? 'unknown';
  const setVersion = text.match(/<version>([^<]*)<\/version>/)?.[1]?.trim() ?? null;
  const entries: DatEntry[] = [];

  for (const g of text.matchAll(/<game\s+name="([^"]*)"[^>]*>([\s\S]*?)<\/game>/g)) {
    const gameName = g[1];
    const rom = g[2].match(/<rom\s+([^>]*)\/?>/);
    if (!rom) continue;
    const attrs = rom[1];
    const attr = (k: string) => attrs.match(new RegExp(`${k}="([^"]*)"`))?.[1] ?? null;
    const name = attr('name');
    if (!name) continue;
    entries.push(toEntry(gameName, name, Number(attr('size') ?? 0),
      hash(attr('crc')), hash(attr('md5')), hash(attr('sha1'))));
  }
  return { setName, setVersion, entries };
}

function parseCmp(text: string): DatFile {
  const header = text.match(/clrmamepro\s*\(([\s\S]*?)\n\s*\)/)?.[1] ?? '';
  const setName = header.match(/name\s+"([^"]*)"/)?.[1] ?? 'unknown';
  const setVersion = header.match(/version\s+(\S+)/)?.[1]?.replace(/"/g, '') ?? null;
  const entries: DatEntry[] = [];

  for (const g of text.matchAll(/\bgame\s*\(([\s\S]*?)\n\)/g)) {
    const body = g[1];
    const gameName = body.match(/\bname\s+"([^"]*)"/)?.[1];
    const rom = body.match(/\brom\s*\((.+)\s*\)$/m)?.[1];
    if (!gameName || !rom) continue;
    const romName = rom.match(/\bname\s+"([^"]*)"/)?.[1];
    if (!romName) continue;
    const field = (k: string) => rom.match(new RegExp(`\\b${k}\\s+([0-9A-Fa-f]+)`))?.[1] ?? null;
    entries.push(toEntry(gameName, romName, Number(rom.match(/\bsize\s+(\d+)/)?.[1] ?? 0),
      hash(field('crc')), hash(field('md5')), hash(field('sha1'))));
  }
  return { setName, setVersion, entries };
}

export function parseDat(text: string): DatFile {
  if (text.trimStart().startsWith('<?xml') || text.includes('<datafile')) return parseXml(text);
  return parseCmp(text);
}
