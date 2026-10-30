// NET: volumes (spec 2026-10-30 §2.2): the request lines the board passes to Transfer, the answer lines it brings
// back, and NET: path <-> Amiga path. Text is Latin-1; a <len>:<text> field counts characters. CLIENT-SAFE, pure.
import { amigaNameProblem } from '@/lib/files/path';
import { QUEUE_FOLDER } from './remote-limits';

export type RemoteKind = 'vols' | 'dir' | 'get';
export type VolumeInfo = { name: string; device: string; size: number; free: number; date: string };
export type EntryInfo = { name: string; dir: boolean; size: number; protection: number; date: string; comment: string };
export type AnswerLine =
  | { t: 'vol'; v: VolumeInfo } | { t: 'ent'; e: EntryInfo } | { t: 'done'; count: number; cut: boolean }
  | { t: 'err'; code: string; text: string } | { t: 'got'; tag: string };

const lp = (s: string) => `${s.length}:${s}`;

export function requestLine(r: { id: string; kind: RemoteKind; amigaPath: string }): string {
  if (r.kind === 'vols') return `VOLS ${r.id}\n`;
  return `${r.kind === 'dir' ? 'DIR' : 'GET'} ${r.id} ${lp(r.amigaPath)}\n`;
}

/** Amiga epoch is 1978-01-01; a tick is 1/50 s. */
export function amigaDateIso(days: number, mins: number, ticks: number): string {
  return new Date(Date.UTC(1978, 0, 1) + days * 86_400_000 + mins * 60_000 + Math.floor(ticks * 20)).toISOString();
}

/** A tiny cursor over one line: words split by single spaces, and <len>:<text> fields. */
class Cursor {
  constructor(private s: string, private i = 0) {}
  word(): string | null {
    if (this.i > this.s.length) return null;
    const j = this.s.indexOf(' ', this.i);
    const w = j < 0 ? this.s.slice(this.i) : this.s.slice(this.i, j);
    this.i = j < 0 ? this.s.length + 1 : j + 1;
    return w;
  }
  lenStr(): string | null {
    const c = this.s.indexOf(':', this.i);
    if (c < 0) return null;
    const n = this.s.slice(this.i, c);
    if (!/^\d{1,4}$/.test(n)) return null;
    const end = c + 1 + Number(n);
    if (end > this.s.length || (end < this.s.length && this.s[end] !== ' ')) return null;
    const v = this.s.slice(c + 1, end);
    this.i = end + 1;
    return v;
  }
  atEnd(): boolean { return this.i >= this.s.length; }
}
const num = (w: string | null, max = 0xFFFFFFFF): number | null => (w !== null && /^\d{1,10}$/.test(w) && Number(w) <= max ? Number(w) : null);
function date(w: string | null): string | null {
  const m = w ? /^(\d{1,6})\.(\d{1,5})\.(\d{1,5})$/.exec(w) : null;
  return m ? amigaDateIso(Number(m[1]), Number(m[2]), Number(m[3])) : null;
}
// A board-sent name is held to the same rules as a name typed in the web app (amigaNameProblem: 30 characters, Latin-1, no ':' or '/', not '.' or '..').
const NAME_OK = (n: string) => amigaNameProblem(n) === null;
const DEVICE = /^[A-Za-z0-9_.-]{1,30}:$/;
const CODES = new Set(['off', 'notfound', 'notdir', 'isdir', 'busy', 'toolarge', 'denied', 'bad', 'io', 'norx', 'old', 'timeout']);

export function parseAnswerLine(rid: string, line: string): AnswerLine | null {
  const c = new Cursor(line);
  const verb = c.word();
  if (c.word() !== rid) return null;
  switch (verb) {
    case 'VOL': {
      const name = c.lenStr(); const device = c.lenStr();
      const size = num(c.word()); const free = num(c.word()); const d = date(c.word());
      if (name === null || !NAME_OK(name) || device === null || !DEVICE.test(device) || size === null || free === null || d === null || !c.atEnd()) return null;
      return { t: 'vol', v: { name, device, size, free, date: d } };
    }
    case 'ENT': {
      const kind = c.word(); const size = num(c.word()); const prot = c.word(); const d = date(c.word());
      const name = c.lenStr(); const comment = c.lenStr();
      if ((kind !== 'd' && kind !== 'f') || size === null || !prot || !/^[0-9a-fA-F]{1,8}$/.test(prot) || d === null
        || name === null || !NAME_OK(name) || comment === null || comment.length > 79 || !c.atEnd()) return null;
      return { t: 'ent', e: { name, dir: kind === 'd', size, protection: parseInt(prot, 16), date: d, comment } };
    }
    case 'DONE': {
      const count = num(c.word(), 1_000_000); const rest = c.word();
      if (count === null || (rest !== null && rest !== 'cut') || !c.atEnd()) return null;
      return { t: 'done', count, cut: rest === 'cut' };
    }
    case 'ERR': {
      const code = c.word(); const text = c.lenStr();
      if (!code || !CODES.has(code) || text === null || !c.atEnd()) return null;
      return { t: 'err', code, text };
    }
    case 'GOT': {
      const tag = c.word();
      if (!tag || !/^\d{1,9}$/.test(tag) || !c.atEnd()) return null;
      return { t: 'got', tag };
    }
  }
  return null;
}

// A duplicate volume is labelled "Name (DEVn:)" (volumeLabel). Transfer resolves that form (spec §2.2), so the
// device suffix is exempt from the ':' rule, but the name before it must still be a name.
const SUFFIXED = /^(.+) \(([A-Za-z0-9_.-]{1,30}:)\)$/;

export function amigaPathOf(segments: string[]): { volume: string; amigaPath: string } | null {
  if (segments.length === 0) return null;
  const [volume, ...rest] = segments;
  const m = SUFFIXED.exec(volume);
  if (!(m ? amigaNameProblem(m[1]) === null : amigaNameProblem(volume) === null)) return null;
  for (const s of rest) if (amigaNameProblem(s) !== null) return null;
  return { volume, amigaPath: `${volume}:${rest.join('/')}` };
}

export function volumeLabel(v: VolumeInfo, all: VolumeInfo[]): string {
  const same = all.filter((x) => x.name.toLowerCase() === v.name.toLowerCase()).length;
  return same > 1 || v.name.toLowerCase() === QUEUE_FOLDER.toLowerCase() ? `${v.name} (${v.device})` : v.name;
}

export function newRequestId(): string {
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  return btoa(String.fromCharCode(...b)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
