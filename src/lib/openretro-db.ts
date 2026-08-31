// Reads the Amiga.sqlite that FS-UAE Launcher syncs from OpenRetro. This is
// the ONLY file that knows the on-disk shape -- zlib framing, BLOB uuids,
// _type discrimination -- so everything downstream sees plain records.
//
// Uses node:sqlite, built into Node, so this adds no dependency (the same
// reasoning that keeps crc32 and adfmfm hand-written).
//
// Structure measured from the operator's real 28.6 MB file; see the design
// doc's section 11. The three facts that break a naive reader:
//   * game.data is zlib-DEFLATE (789c), not gzip. gunzip throws on it.
//   * uuid is a 16-byte BLOB, while parent_uuid inside the JSON is a
//     hyphenated string. Without converting, every variant orphans silently.
//   * one row has empty data and must be skipped, not treated as corrupt.
//   * _type is the STRING "1"/"2", not the number 1/2. Measured on the real
//     file: 3,697 rows of "1" and 17,742 of "2", and a `=== 1` test matches
//     none of them. The plan's fixture used numbers and so passed while the
//     real file yielded nothing at all. Compared as a string, tolerating both.

import { DatabaseSync } from 'node:sqlite';
import { inflateSync } from 'node:zlib';
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

export interface OpenRetroVariant {
  uuid: string; parentUuid: string | null;
  fileSha1s: string[];
  chipset: string | null; videoStandard: string | null;
  protection: string | null; variantName: string | null; source: string | null;
}

export interface OpenRetroGame {
  uuid: string; gameName: string; slug: string | null;
  publisher: string | null; developer: string | null; year: number | null;
  languages: string | null; players: string | null; tags: string | null;
  frontSha1: string | null; titleSha1: string | null; screenshotSha1s: string[];
  holUrl: string | null; mobygamesUrl: string | null; lemonUrl: string | null;
  wikipediaUrl: string | null; longplayUrl: string | null;
}

export interface OpenRetroData { games: OpenRetroGame[]; variants: OpenRetroVariant[]; version: number | null }

/** 16 raw bytes -> the hyphenated form parent_uuid uses. */
function toUuid(blob: Uint8Array): string {
  const h = Buffer.from(blob).toString('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

const str = (v: unknown): string | null => {
  const s = typeof v === 'string' ? v.trim() : '';
  return s.length > 0 ? s : null;
};
const sha = (v: unknown): string | null => {
  const s = str(v);
  return s && /^[0-9a-fA-F]{40}$/.test(s) ? s.toLowerCase() : null;
};

export function readOpenRetroDb(bytes: Uint8Array): OpenRetroData {
  // node:sqlite opens a path, not a buffer, so the upload is spilled to a
  // temp file and removed again. Deliberate: the alternative is a WASM
  // SQLite build, which would be a dependency for no gain.
  const dir = mkdtempSync(join(tmpdir(), 'oagd-'));
  const path = join(dir, 'db.sqlite');
  writeFileSync(path, bytes);
  try {
    const db = new DatabaseSync(path, { readOnly: true });
    let version: number | null = null;
    try {
      const m = db.prepare('select version from metadata limit 1').get() as { version?: number } | undefined;
      version = typeof m?.version === 'number' ? m.version : null;
    } catch { /* a file without a metadata table is still usable */ }

    const games: OpenRetroGame[] = [];
    const variants: OpenRetroVariant[] = [];

    for (const row of db.prepare('select uuid, data from game').all() as Array<{ uuid: Uint8Array; data: Uint8Array }>) {
      const raw = Buffer.from(row.data ?? []);
      if (raw.length === 0) continue;            // the one empty row
      let j: Record<string, unknown>;
      try { j = JSON.parse(inflateSync(raw).toString('utf8')); } catch { continue; }
      const uuid = toUuid(row.uuid);

      const type = String(j._type);

      if (type === '2') {
        let fileSha1s: string[] = [];
        try {
          const list = JSON.parse(String(j.file_list ?? '[]')) as Array<{ sha1?: string }>;
          fileSha1s = list.map((f) => sha(f.sha1)).filter((s): s is string => s !== null);
        } catch { fileSha1s = []; }
        variants.push({
          uuid, parentUuid: str(j.parent_uuid), fileSha1s,
          chipset: str(j.chipset), videoStandard: str(j.video_standard),
          protection: str(j.protection), variantName: str(j.variant_name),
          source: str(j.__source),
        });
      } else if (type === '1') {
        // 1-5 are plain; 6-8 carry a `__` prefix in the real file (415 games
        // have __screen6_sha1). Both spellings are read so a game does not
        // silently lose its last three screenshots.
        const screenshotSha1s: string[] = [];
        for (let i = 1; i <= 8; i++) {
          const s = sha(j[`screen${i}_sha1`]) ?? sha(j[`__screen${i}_sha1`]);
          if (s) screenshotSha1s.push(s);
        }
        const year = Number(j.year);
        games.push({
          uuid, gameName: str(j.game_name) ?? '(unnamed)', slug: str(j.__link_name),
          publisher: str(j.publisher), developer: str(j.developer),
          year: Number.isFinite(year) && year > 0 ? year : null,
          languages: str(j.languages), players: str(j.players), tags: str(j.tags),
          frontSha1: sha(j.front_sha1), titleSha1: sha(j.title_sha1), screenshotSha1s,
          holUrl: str(j.hol_url), mobygamesUrl: str(j.mobygames_url),
          lemonUrl: str(j.lemon_url), wikipediaUrl: str(j.wikipedia_url),
          longplayUrl: str(j.longplay_url),
        });
      }
    }
    db.close();
    return { games, variants, version };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
