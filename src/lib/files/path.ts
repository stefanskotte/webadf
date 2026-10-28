// Files (spec 2026-10-29 §3.1): every place a pane can point at. CLIENT-SAFE: no imports.
// LIBRARY:/<gameId>/<diskId>/<dir>/<file>: titles and disks by id, so two titles with one name never collide; inside a
// disk, AmigaDOS names. STASH: and NET: arrive in increments 2 and 3.

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
