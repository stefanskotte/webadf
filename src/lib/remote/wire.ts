// The owner's listings, checked before the remote pages render them (library sharing spec §4.2 Browse). The recipient
// routes pass the owner's JSON on as sent (src/lib/remote/http.ts proxyListing); a page must not crash, or show
// something odd, on a malformed or hostile answer. Pure and CLIENT-SAFE. Null = "not a share API answer".
import type {
  ShareDisk, ShareEntry, ShareFiles, ShareLibrary, ShareTitle, ShareTitleDetail, ShareTitlesPage, ShareUsage, ShareVolume,
} from '@/lib/share/types';

const MAX_TEXT = 300;
const MAX_DEPTH = 32;

const obj = (v: unknown): Record<string, unknown> | null => (v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : null);
const str = (v: unknown, max = MAX_TEXT): string | null =>
  typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f]+/g, ' ').slice(0, max) : null;
const id = (v: unknown): string | null => (typeof v === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(v) ? v : null);
const int = (v: unknown, min = 0): number | null => (typeof v === 'number' && Number.isInteger(v) && v >= min ? v : null);
const strOrNull = (v: unknown) => (v === null || v === undefined ? null : str(v));
const iso = (v: unknown): string | null => (typeof v === 'string' && !Number.isNaN(Date.parse(v)) ? v : null);

function list<T>(v: unknown, each: (x: unknown) => T | null): T[] | null {
  if (!Array.isArray(v)) return null;
  const out: T[] = [];
  for (const x of v) {
    const y = each(x);
    if (y !== null) out.push(y);
  }
  return out;
}

export function checkLibrary(raw: unknown): ShareLibrary | null {
  const o = obj(raw);
  if (!o) return null;
  const name = str(o.name);
  const collections = list(o.collections, (c) => {
    const x = obj(c);
    const cid = x && id(x.id);
    const cname = x && str(x.name);
    return cid && cname !== null ? { id: cid, name: cname, titles: int(x!.titles) ?? 0 } : null;
  });
  if (name === null || collections === null) return null;
  return { name, collections, titles: int(o.titles) ?? 0, disks: int(o.disks) ?? 0 };
}

export function checkTitle(raw: unknown): ShareTitle | null {
  const o = obj(raw);
  const tid = o && id(o.id);
  const title = o && str(o.title);
  if (!o || !tid || title === null) return null;
  return {
    id: tid, title: title.trim() || 'Untitled', year: int(o.year), publisher: strOrNull(o.publisher), kind: strOrNull(o.kind),
    diskCount: int(o.diskCount) ?? 0, hasCover: o.hasCover === true,
    coverDigest: typeof o.coverDigest === 'string' && /^[A-Za-z0-9._-]{1,128}$/.test(o.coverDigest) ? o.coverDigest : null,
    collectionIds: list(o.collectionIds, id) ?? [],
  };
}

export function checkTitlesPage(raw: unknown): ShareTitlesPage | null {
  const o = obj(raw);
  const titles = o && list(o.titles, checkTitle);
  if (!o || !titles) return null;
  const next = typeof o.nextCursor === 'string' && o.nextCursor.length <= 200 ? o.nextCursor : null;
  return { titles, nextCursor: next };
}

export function checkDisk(raw: unknown): ShareDisk | null {
  const o = obj(raw);
  const did = o && id(o.id);
  if (!o || !did) return null;
  const diskNo = int(o.diskNo, 1);
  const sha256 = typeof o.sha256 === 'string' && /^[0-9a-f]{64}$/.test(o.sha256) ? o.sha256 : null;
  const imageFormat = o.imageFormat === 'adf' || o.imageFormat === 'hfe' ? o.imageFormat : null;
  if (diskNo === null || sha256 === null || imageFormat === null) return null;
  return {
    id: did, name: str(o.name) ?? '', diskNo, sizeBytes: int(o.sizeBytes) ?? 0, sha256, imageFormat,
    extractable: o.extractable === true, updatedAt: iso(o.updatedAt) ?? new Date(0).toISOString(),
  };
}

export function checkTitleDetail(raw: unknown): ShareTitleDetail | null {
  const o = obj(raw);
  const title = o && checkTitle(o.title);
  const disks = o && list(o.disks, checkDisk);
  if (!title || !disks) return null;
  return { title, disks: disks.sort((a, b) => a.diskNo - b.diskNo) };
}

function checkEntry(raw: unknown, depth: number): ShareEntry | null {
  const o = obj(raw);
  const name = o && str(o.name, 120);
  if (!o || !name || (o.kind !== 'file' && o.kind !== 'dir')) return null;
  const e: ShareEntry = {
    name, kind: o.kind, sizeBytes: int(o.sizeBytes) ?? 0, modifiedAt: iso(o.modifiedAt),
    protection: str(o.protection, 16) ?? '', comment: strOrNull(o.comment),
  };
  if (o.kind === 'dir') e.children = depth < MAX_DEPTH ? (list(o.children, (c) => checkEntry(c, depth + 1)) ?? []) : [];
  return e;
}

function checkVolume(raw: unknown): ShareVolume | null {
  const o = obj(raw);
  if (!o) return null;
  return {
    filesystem: str(o.filesystem, 16) ?? '', intl: o.intl === true, dirc: o.dirc === true, name: str(o.name, 60) ?? '',
    createdAt: iso(o.createdAt), modifiedAt: iso(o.modifiedAt),
  };
}

function checkUsage(raw: unknown): ShareUsage | null {
  const o = obj(raw);
  if (!o) return null;
  const n = (k: string) => (typeof o[k] === 'number' && Number.isFinite(o[k] as number) ? o[k] as number : 0);
  return {
    totalBlocks: n('totalBlocks'), usedBlocks: n('usedBlocks'), freeBlocks: n('freeBlocks'),
    totalBytes: n('totalBytes'), usedBytes: n('usedBytes'), freeBytes: n('freeBytes'), percentUsed: n('percentUsed'),
  };
}

export function checkFiles(raw: unknown): ShareFiles | null {
  const o = obj(raw);
  if (!o) return null;
  if (typeof o.unreadable === 'string') return { unreadable: str(o.unreadable) ?? '' };
  const volume = checkVolume(o.volume);
  const root = list(o.root, (e) => checkEntry(e, 0));
  if (!volume || !root) return null;
  return { volume, root, usage: o.usage === null || o.usage === undefined ? null : checkUsage(o.usage) };
}
