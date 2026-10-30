// Files (spec 2026-10-29 §3.1): every place a pane can point at. CLIENT-SAFE: no imports.
// LIBRARY:/<gameId>/<diskId>/<dir>/<file>: titles and disks by id, so two titles with one name never collide; inside a
// disk, AmigaDOS names. STASH:/<folder>/<file>: by name (increment 2). NET:/<deviceId>/Queue/<transferId>: boards and
// their queue rows by id (increment 3, R1); NET:/<deviceId>/<Volume>/<drawer>/…: the Amiga's volumes (spec 2026-10-30).

export type Device = 'STASH' | 'NET' | 'LIBRARY';
export type FsPath = { device: Device; segments: string[] };

export const AMIGA_NAME_MAX = 30;
export const AMIGA_COMMENT_MAX = 79;
const SEGMENT_MAX = 255;
const DEPTH_MAX = 40;
const DEVICES: readonly Device[] = ['STASH', 'NET', 'LIBRARY'];
const CONTROL = /[\u0000-\u001f\u007f]/;
// C1 controls: in Latin-1 they are code points 0x80-0x9F, which AmigaDOS would store as invisible junk.
const C1 = /[\u0080-\u009f]/;
// AmigaDOS names are single-byte Latin-1: anything above U+00FF would be mangled on disk.
const NOT_LATIN1 = /[^\u0000-ÿ]/;

export function parsePath(raw: string): FsPath | null {
  const m = /^([A-Z]+):(\/.*)?$/.exec(raw);
  if (!m || !DEVICES.includes(m[1] as Device)) return null;
  const device = m[1] as Device;
  if (!m[2] || m[2] === '/') return { device, segments: [] };
  const body = m[2].endsWith('/') ? m[2].slice(1, -1) : m[2].slice(1);
  const segments = body.split('/');
  if (segments.length > DEPTH_MAX) return null;
  for (const s of segments) {
    if (!s || s === '.' || s === '..' || s.length > SEGMENT_MAX || CONTROL.test(s)) return null;
  }
  return { device, segments };
}

export function formatPath(p: FsPath): string {
  return p.segments.length ? `${p.device}:/${p.segments.join('/')}` : `${p.device}:`;
}

/** The devices the panes show, in the device column's order (Files 2 R12): STASH:, LIBRARY:, NET:. */
export const PANE_DEVICES: readonly Device[] = ['STASH', 'LIBRARY', 'NET'];
/** Where the panes start when the URL names no place (increment 2, R1). */
export const DEFAULT_LEFT = 'STASH:';
export const DEFAULT_RIGHT = 'LIBRARY:';

/**
 * Files with STASH: on the left and a library disk open on the right (increment 2, R1): what "Files…" and every link
 * to a disk's files opens -- inside `collectionId` when the title is filed (Files 2 §3.1: its first collection), else
 * at LIBRARY:/<title>/<disk>. `#disk-history` (`history`) opens the disk strip's History over the pane.
 */
export function filesHrefForDisk(gameId: string, diskId: string, history = false, collectionId: string | null = null): string {
  const right = collectionId ? `LIBRARY:/${collectionId}/${gameId}/${diskId}` : `LIBRARY:/${gameId}/${diskId}`;
  return `/files?left=${DEFAULT_LEFT}&right=${encodeURIComponent(right)}&active=right${history ? '#disk-history' : ''}`;
}

/**
 * Files with STASH: on the left and a board's NET: queue on the right (increment 3, R10/R11): where the old Upload
 * page's board links go. `active` picks the pane the keys start in: the queue (`right`) for a send, STASH: (`left`)
 * for files from the Amiga.
 */
export function filesHrefForBoard(deviceId: string, active: 'left' | 'right'): string {
  // The queue is the board's Queue folder since NET: volumes (spec 2026-10-30 §4.3; QUEUE_FOLDER, kept literal: no imports).
  return `/files?left=${DEFAULT_LEFT}&right=${encodeURIComponent(`NET:/${deviceId}/Queue`)}&active=${active}`;
}

export function parentOf(p: FsPath): FsPath | null {
  return p.segments.length ? { device: p.device, segments: p.segments.slice(0, -1) } : null;
}

export function childOf(p: FsPath, name: string): FsPath {
  return { device: p.device, segments: [...p.segments, name] };
}

/** `inner` is `outer` or below it. `sameName` decides one segment (AmigaDOS: case-insensitive, intl-aware). */
export function isWithin(inner: FsPath, outer: FsPath, sameName: (a: string, b: string) => boolean): boolean {
  if (inner.device !== outer.device || inner.segments.length < outer.segments.length) return false;
  return outer.segments.every((s, i) => sameName(inner.segments[i], s));
}

export function amigaNameProblem(name: string): 'empty' | 'too-long' | 'bad-char' | null {
  if (!name.trim()) return 'empty';
  if ([...name].length > AMIGA_NAME_MAX) return 'too-long';
  // "." and ".." are refused as path segments by parsePath, so a folder with either name would be unreachable.
  if (name === '.' || name === '..') return 'bad-char';
  if (name.includes(':') || name.includes('/') || CONTROL.test(name) || C1.test(name) || NOT_LATIN1.test(name)) {
    return 'bad-char';
  }
  return null;
}
