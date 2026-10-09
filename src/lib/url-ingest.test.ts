import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createHash } from 'node:crypto';
import { gzipSync, deflateRawSync } from 'node:zlib';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fixture } from '@/lib/hfe/__fixtures__/load';
import type { UrlFetchResult } from './url-fetch';

const registerUploads = vi.fn();
vi.mock('@/lib/ingest-complete', () => ({ registerUploads: (...a: unknown[]) => registerUploads(...a) }));

const put = vi.fn<(sha: string, bytes: Uint8Array) => Promise<{ key: string }>>(async (sha) => ({ key: `adf/${sha}` }));
vi.mock('@/lib/storage', () => ({ diskStore: { put: (s: string, b: Uint8Array) => put(s, b) } }));

/** Rows the blobs lookup answers with. */
let knownRows: { sha256: string }[] = [];
vi.mock('@/db', () => ({
  getDb: () => ({ select: () => ({ from: () => ({ where: () => Promise.resolve(knownRows) }) }) }),
}));

const { ingestFromUrl, prepareImages, nameFromResponse, sniff, cleanName, MAX_IMAGES_PER_URL } = await import('./url-ingest');

const ADF = (fill: number) => new Uint8Array(901_120).fill(fill);
const HD = new Uint8Array(1_802_240).fill(3);
const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');

/** A minimal zip (deflate or stored members), built here so the test controls every byte. */
function zip(members: { name: string; bytes: Uint8Array; store?: boolean }[]): Uint8Array {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const m of members) {
    const data = m.store ? Buffer.from(m.bytes) : deflateRawSync(m.bytes);
    const name = Buffer.from(m.name);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(m.store ? 0 : 8, 8);
    lh.writeUInt32LE(data.length, 18); lh.writeUInt32LE(m.bytes.length, 22); lh.writeUInt16LE(name.length, 26);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(m.store ? 0 : 8, 10);
    ch.writeUInt32LE(data.length, 20); ch.writeUInt32LE(m.bytes.length, 24); ch.writeUInt16LE(name.length, 28);
    ch.writeUInt32LE(offset, 42);
    locals.push(lh, name, data);
    centrals.push(ch, name);
    offset += 30 + name.length + data.length;
  }
  const cen = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(members.length, 8); eocd.writeUInt16LE(members.length, 10);
  eocd.writeUInt32LE(cen.length, 12); eocd.writeUInt32LE(offset, 16);
  return new Uint8Array(Buffer.concat([...locals, cen, eocd]));
}

const fetched = (bytes: Uint8Array, url = 'https://files.example/games/Turrican.adf', cd: string | null = null) =>
  async (): Promise<UrlFetchResult> => ({ ok: true, bytes, finalUrl: new URL(url), contentDisposition: cd });

const okRegister = (rejectedReasons: Record<string, string> = {}, status = 200) =>
  registerUploads.mockImplementation(async () => Response.json({ created: 1, rejected: Object.keys(rejectedReasons), rejectedReasons }, { status }));

beforeEach(() => {
  vi.clearAllMocks();
  knownRows = [];
  okRegister();
});

describe('naming', () => {
  it('prefers Content-Disposition, filename* first', () => {
    const u = new URL('https://x.example/download.php?id=3');
    expect(nameFromResponse(u, `attachment; filename*=UTF-8''Gods%20(1991).adf`)).toBe('Gods (1991).adf');
    expect(nameFromResponse(u, 'attachment; filename="Gods.adf"')).toBe('Gods.adf');
    expect(nameFromResponse(u, 'attachment; filename=Gods.adf')).toBe('Gods.adf');
  });

  it('falls back to the last path segment, decoded', () => {
    expect(nameFromResponse(new URL('https://x.example/a/Lotus%20II.adf'), null)).toBe('Lotus II.adf');
    expect(nameFromResponse(new URL('https://x.example/'), null)).toBe('download');
  });

  it('strips paths and control characters from offered names', () => {
    expect(cleanName('../../etc/passwd')).toBe('passwd');
    expect(cleanName('C:\\x\\Disk\u0000\u001b.adf')).toBe('Disk.adf');
  });
});

describe('sniff', () => {
  it('recognises formats by signature or exact ADF size, never by name', () => {
    expect(sniff(ADF(0))).toBe('adf');
    expect(sniff(HD)).toBe('adf');
    expect(sniff(new Uint8Array(901_121))).toBe('unknown');
    expect(sniff(new TextEncoder().encode('<!doctype html><html>404</html>'))).toBe('unknown');
    expect(sniff(zip([{ name: 'a.adf', bytes: ADF(1) }]))).toBe('zip');
    expect(sniff(new Uint8Array(gzipSync(ADF(1))))).toBe('gzip');
    expect(sniff(fixture('clean'))).toBe('hfe');
    expect(sniff(new Uint8Array(readFileSync(join(__dirname, 'archive', 'fixtures', 'h1.lha'))))).toBe('lha');
    expect(sniff(new Uint8Array([0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c, 0, 4]))).toBe('other-archive');
  });
});

describe('prepareImages', () => {
  it('names a bare ADF after the offered name, whatever its extension said', async () => {
    const r = await prepareImages(ADF(1), 'download.php');
    expect('images' in r && r.images.map((i) => i.filename)).toEqual(['download.adf']);
  });

  it('turns a gzipped ADF into the ADF (same identity as the .adf)', async () => {
    const r = await prepareImages(new Uint8Array(gzipSync(ADF(5))), 'Game.adf.gz');
    expect('images' in r && r.images[0].filename).toBe('Game.adf');
    expect('images' in r && sha(r.images[0].bytes)).toBe(sha(ADF(5)));
  });

  it('refuses a gzip that is not an ADF', async () => {
    expect(await prepareImages(new Uint8Array(gzipSync(Buffer.from('hello'))), 'x.gz')).toEqual({ code: 'not_a_disk_image' });
  });

  it('refuses an HTML page, an odd-sized file, LHA and 7z', async () => {
    expect(await prepareImages(new TextEncoder().encode('<html>nope</html>'), 'x.adf')).toEqual({ code: 'not_a_disk_image' });
    expect(await prepareImages(new Uint8Array(1000), 'x.adf')).toEqual({ code: 'not_a_disk_image' });
    expect(await prepareImages(new Uint8Array(readFileSync(join(__dirname, 'archive', 'fixtures', 'h1.lha'))), 'x.lha'))
      .toEqual({ code: 'unsupported_archive' });
    expect(await prepareImages(new Uint8Array([0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c, 0, 4]), 'x.7z')).toEqual({ code: 'unsupported_archive' });
  });

  it('takes the disk images out of a zip and ignores everything else', async () => {
    const r = await prepareImages(zip([
      { name: 'Game/Disk1.adf', bytes: ADF(1) },
      { name: 'Game/Disk2.adz', bytes: new Uint8Array(gzipSync(ADF(2))), store: true },
      { name: 'Game/readme.txt', bytes: new TextEncoder().encode('hi') },
      { name: '__MACOSX/Game/._Disk1.adf', bytes: new Uint8Array(10) },
    ]), 'Game.zip');
    expect('images' in r && r.images.map((i) => i.filename)).toEqual(['Disk1.adf', 'Disk2.adf']);
    expect('images' in r && r.refused).toEqual([]);
  });

  it('reports a bad member by name instead of dropping it', async () => {
    const r = await prepareImages(zip([{ name: 'Broken.dms', bytes: new Uint8Array(100) }]), 'x.zip');
    expect('refused' in r && r.refused[0]).toMatchObject({ filename: 'Broken.dms', state: 'failed' });
  });

  it('says so when a zip holds no disk images', async () => {
    expect(await prepareImages(zip([{ name: 'readme.txt', bytes: new Uint8Array(4) }]), 'x.zip')).toEqual({ code: 'no_disk_images' });
  });

  it(`refuses a zip with more than ${MAX_IMAGES_PER_URL} disk images`, async () => {
    const members = Array.from({ length: MAX_IMAGES_PER_URL + 1 }, (_, i) => ({ name: `D${i}.adf`, bytes: ADF(i) }));
    expect(await prepareImages(zip(members), 'x.zip')).toEqual({ code: 'too_many_images' });
  });

  it('refuses a deflate bomb member without inflating it whole', async () => {
    const r = await prepareImages(zip([{ name: 'Bomb.adf', bytes: new Uint8Array(64 * 1024 * 1024) }]), 'x.zip');
    expect('refused' in r && r.refused[0]).toMatchObject({ filename: 'Bomb.adf', note: 'too large' });
  });

  it('inspects an HFE the way the dropzone does, refusals included', async () => {
    const ok = await prepareImages(fixture('clean'), 'Disk.hfe');
    expect('images' in ok && ok.images[0].filename).toBe('Disk.hfe');
    const v3 = await prepareImages(fixture('v3'), 'Disk.hfe');
    expect('refused' in v3 && v3.refused[0].note).toMatch(/v3/);
  });
});

describe('ingestFromUrl', () => {
  it('stores a new image and registers it through registerUploads, for the given org', async () => {
    const bytes = ADF(1);
    const r = await ingestFromUrl('org-1', 'https://files.example/games/Turrican.adf', { fetch: fetched(bytes) });
    expect(r).toEqual({ ok: true, rows: [{ filename: 'Turrican.adf', sizeBytes: 901_120, sha256: sha(bytes), state: 'done' }] });
    expect(put).toHaveBeenCalledWith(sha(bytes), bytes);
    expect(registerUploads).toHaveBeenCalledWith('org-1', [{ sha256: sha(bytes), sizeBytes: 901_120, filename: 'Turrican.adf' }]);
  });

  it('does not store bytes the store already holds, and reports them deduped', async () => {
    const bytes = ADF(2);
    knownRows = [{ sha256: sha(bytes) }];
    const r = await ingestFromUrl('org-1', 'https://x.example/a.adf', { fetch: fetched(bytes) });
    expect(put).not.toHaveBeenCalled();
    expect(registerUploads).toHaveBeenCalledTimes(1);
    expect(r.ok && r.rows[0].state).toBe('deduped');
  });

  it('carries a registration refusal onto the row', async () => {
    const bytes = ADF(3);
    okRegister({ [sha(bytes)]: 'digest-mismatch' }, 409);
    const r = await ingestFromUrl('org-1', 'https://x.example/a.adf', { fetch: fetched(bytes) });
    expect(r.ok && r.rows[0]).toMatchObject({ state: 'failed', note: 'digest-mismatch' });
  });

  it('passes a fetch refusal through as its code, touching nothing', async () => {
    const r = await ingestFromUrl('org-1', 'http://10.0.0.1/', { fetch: async () => ({ ok: false, code: 'address_not_allowed' }) });
    expect(r).toEqual({ ok: false, code: 'address_not_allowed' });
    expect(put).not.toHaveBeenCalled();
    expect(registerUploads).not.toHaveBeenCalled();
  });

  it('refuses content that is not a disk image before storing anything', async () => {
    const r = await ingestFromUrl('org-1', 'https://x.example/a.adf', { fetch: fetched(new TextEncoder().encode('<html>')) });
    expect(r).toEqual({ ok: false, code: 'not_a_disk_image' });
    expect(put).not.toHaveBeenCalled();
  });

  it('registers each distinct disk of a zip once', async () => {
    const r = await ingestFromUrl('org-1', 'https://x.example/set.zip', {
      fetch: fetched(zip([{ name: 'A Disk1.adf', bytes: ADF(1) }, { name: 'A Disk2.adf', bytes: ADF(2) }, { name: 'copy.adf', bytes: ADF(1) }])),
    });
    expect(r.ok && r.rows.map((x) => x.filename)).toEqual(['A Disk1.adf', 'A Disk2.adf']);
    expect(put).toHaveBeenCalledTimes(2);
  });

  it('maps a busy store to store_busy', async () => {
    registerUploads.mockImplementation(async () => Response.json({ error: 'blob store rate limited' }, { status: 503 }));
    expect(await ingestFromUrl('org-1', 'https://x.example/a.adf', { fetch: fetched(ADF(4)) })).toEqual({ ok: false, code: 'store_busy' });
    put.mockRejectedValueOnce(new Error('boom'));
    expect(await ingestFromUrl('org-1', 'https://x.example/a.adf', { fetch: fetched(ADF(6)) })).toEqual({ ok: false, code: 'store_busy' });
  });
});
