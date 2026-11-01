// The Files manager's small decisions, out of the component so they can be tested (final review of increment 1).
// CLIENT-SAFE: no database import.
import { SIGNED_OUT_TEXT } from '@/lib/signed-out';
import { ZIP_MAX_BYTES, type ClashChoice } from './transfer';
import type { Listing } from './types';
import type { OpItem } from './driver';
import { formatPath, parentOf, parsePath } from './path';
import { keptWords } from '@/lib/remote-browse';

/**
 * The disk whose strip a pane shows: the disk its listing is inside, else -- when the listing failed because the image
 * could not be read -- the disk the refusal named (`errorDisk`, the blob_unavailable detail; Files 2 R2: never parsed
 * from the path, which may run through a collection). The strip needs no image; its History and Restore are how such a
 * disk is mended. Null above the disks.
 */
export function stripDiskOf(p: { listing: Listing | null; errorDisk: string | null }): string | null {
  return p.listing ? p.listing.disk?.diskId ?? null : p.errorDisk;
}

/** A drop while an operation runs is not taken; said, rather than lost without a word. */
export const BUSY_DROP = 'Wait for the current operation to finish, then drop again.';
/** Nor while a dialog is open: the drop would replace it, and whatever it was in the middle of. */
export const DIALOG_DROP = 'Finish or close the open dialog, then drop again.';

/** Why a drop is not taken now, or null. */
export function dropBlocked(s: { busy: boolean; dialogOpen: boolean }): string | null {
  return s.busy ? BUSY_DROP : s.dialogOpen ? DIALOG_DROP : null;
}

/** An op refused because a pane was out of date (the disk changed, or what it showed is gone): both panes reload. */
export function reloadsBoth(code: unknown): boolean {
  return code === 'conflict' || code === 'not_found';
}

export const TOO_BIG_WORDS = `Too big to download at once — select fewer files (${ZIP_MAX_BYTES / (1024 * 1024)} MB).`;

/** The name a download's content-disposition gives (RFC 5987 `filename*`, as download/route.ts writes it). */
function nameOf(disposition: string | null): string {
  const m = disposition?.match(/filename\*=UTF-8''([^;]+)/i);
  if (!m) return '';
  try { return decodeURIComponent(m[1]); } catch { return ''; }
}

export type Fetched =
  | { ok: true; blob: Blob; name: string }
  /** `words` when the refusal is the download's own (too large); else the body's code and detail, for the caller. */
  | { ok: false; words: string }
  | { ok: false; code: unknown; detail: unknown };

/**
 * A download fetched rather than navigated to, so a refusal is read as words instead of being saved as a file. Only
 * a 2xx is bytes; a body that is not JSON leaves the code undefined (a plain failure); no answer at all is 'failed'.
 */
export async function fetchDownload(href: string, fetchImpl: (href: string) => Promise<Response> = (h) => fetch(h)): Promise<Fetched> {
  let res: Response;
  try { res = await fetchImpl(href); } catch { return { ok: false, code: 'failed', detail: undefined }; }
  // Signed out, the fetch follows the redirect to the sign-in page: a page, not the file (a download is never HTML).
  if (res.redirected || (res.ok && (res.headers.get('content-type') ?? '').includes('text/html'))) return { ok: false, words: SIGNED_OUT_TEXT };
  if (res.ok) return { ok: true, blob: await res.blob(), name: nameOf(res.headers.get('content-disposition')) };
  const body = (await res.json().catch(() => null)) as { error?: unknown; detail?: unknown } | null;
  if (res.status === 413 && body?.error === 'too_large') return { ok: false, words: TOO_BIG_WORDS };
  return { ok: false, code: body?.error, detail: body?.detail };
}

/** What a finished op did, item by item: written, skipped (a clash answered Skip), refused. */
export type Tally = { done: number; skipped: number; failed: number };
export function tallyItems(items: OpItem[]): Tally {
  const skipped = items.filter((i) => i.ok && i.skipped).length;
  const failed = items.filter((i) => !i.ok).length;
  return { done: items.length - skipped - failed, skipped, failed };
}

/** A clash answered Skip: the item is left as it was on both sides, and said so rather than counted as done. */
export const skippedWords = (n: number) => `Skipped ${n} (already there).`;

/**
 * An op's toast title (final review): `said(n)` for what was done, then what was skipped, then what could not be done;
 * a skipped item is never counted as moved, copied or added. Nothing done or skipped: "Nothing was done."
 */
export function opTitle(t: Tally, said: (n: number) => string, count: (n: number) => string): string {
  if (t.done === 0 && t.skipped === 0) return 'Nothing was done.';
  return [
    ...(t.done > 0 ? [said(t.done)] : []),
    ...(t.skipped > 0 ? [skippedWords(t.skipped)] : []),
    ...(t.failed > 0 ? [`${count(t.failed)} could not be done.`] : []),
  ].join(' ');
}

/** The sources mixed clash answers leave out of every request (clashGroups): reported as skipped all the same. */
export function skippedItems(sources: string[], choices: Record<string, ClashChoice>): OpItem[] {
  const answers = new Set(Object.values(choices));
  if (answers.size < 2) return [];   // one answer for all is one request, and the driver says what it skipped
  return sources.filter((s) => choices[s] === 'skip').map((source) => ({ source, ok: true, skipped: true }));
}

/** A drop into STASH:'s toast title: "Added 3 items to STASH:/Mods", then what was skipped. */
export function stashTitle(added: number, skipped: number, dir: string, count: (n: number) => string): string {
  const head = added > 0 ? `Added ${count(added)} to ${dir}` : 'Nothing was added.';
  if (!skipped) return head;
  return `${added > 0 ? `${head}.` : head} ${skippedWords(skipped)}`;
}

/**
 * Create ADF…: whether the dialog closes. Only a made disk (or one the clash setting skipped) closes it; a refused item,
 * a refused op or a clash keeps it open with the typed name, to be changed and tried again (Task 7 review).
 */
export function createClosesDialog(r: { kind: 'done'; items: OpItem[] } | { kind: 'refused' | 'clashes' }): boolean {
  return r.kind === 'done' && r.items[0]?.ok === true;
}

/**
 * A guard that runs one async call at a time: a call while one is in flight is refused (returns false), so Enter and a
 * click in the same moment cannot submit twice -- before the busy state has re-rendered the button disabled.
 */
export function oneAtATime(): (go: () => Promise<unknown>) => boolean {
  let running = false;
  return (go) => {
    if (running) return false;
    running = true;
    go().catch(() => {}).finally(() => { running = false; });
    return true;
  };
}

/**
 * Where Parent and Root go from a pane (Files 2 §2.3), null at the top. From the listing's crumbs (their paths may run
 * through a collection); a pane showing an error has no listing, so then from its path -- Root must still work from a
 * deep place that is gone (Task 8 review).
 */
export function navTargets(listing: { crumbs: { path: string }[] } | null, path: string): { parent: string | null; root: string | null } {
  if (listing) {
    const c = listing.crumbs;
    return c.length > 1 ? { parent: c[c.length - 2].path, root: c[0].path } : { parent: null, root: null };
  }
  const p = parsePath(path);
  const up = p && parentOf(p);
  return up ? { parent: formatPath(up), root: `${p.device}:` } : { parent: null, root: null };
}

/**
 * The status row of a copy out of a NET: volume (spec 2026-10-30 §4.5), from GET /api/files/net/fetch/<id>: the file
 * now on its way while any wait, then the summary, naming the first failure ("; …" when there are more).
 */
export function fetchStatus(p: { total: number; done: number; failed: { name: string; reason: string }[]; waiting: number }, board: string): { line: string; finished: boolean } {
  if (p.waiting > 0) return { line: `Copying ${Math.min(p.done + p.failed.length + 1, p.total)} of ${p.total} from ${board}…`, finished: false };
  const [first, ...more] = p.failed;
  const failed = first ? `, ${p.failed.length} failed: ${first.name}: ${first.reason}${more.length ? '; …' : ''}` : '';
  return { line: `Copied ${p.done}${failed}`, finished: true };
}

type JobWriteView = { kind: string; label: string; to: string | null; status: 'waiting' | 'running' | 'done' | 'failed'; removed: number;
  reason: string | null; entry: string | null; quiet: boolean;
  /** A move's removal that kept a drawer something new is in (spec 2026-10-31 §9). */
  kept?: boolean; restIn?: string | null };
const RUNNING: Record<string, string> = { delete: 'Deleting', mkdir: 'Making', rename: 'Renaming', protect: 'Protecting', note: 'Setting the comment on' };

/** One finished write in words: "Deleted Work:old (137)", "Made Work:New", "Renamed Work:a to Work:b". */
function doneWords(w: JobWriteView): string {
  switch (w.kind) {
    case 'delete': return `Deleted ${w.label}${w.removed > 1 ? ` (${w.removed})` : ''}`;
    case 'mkdir': return `Made ${w.label}`;
    case 'rename': return `Renamed ${w.label}${w.to ? ` to ${w.to}` : ''}`;
    case 'protect': return `Protected ${w.label}`;
    default: return `Comment on ${w.label}`;
  }
}
const PAST: Record<string, string> = { delete: 'Deleted', mkdir: 'Made', rename: 'Renamed', protect: 'Protected', note: 'Commented on' };

/**
 * The status row of a job that changes the Amiga's disks (spec 2026-10-31 §2.3, §4.1), from GET /api/files/net/fetch/<id>.
 * While it runs: the write on its way ("Deleting Work:old on A500… removed 37 so far") or the file ("Copying 3 of 12 to
 * A500…"). Then what was done and why anything was not -- a delete stopped half way says how far it got. An icon taken
 * along, or a drawer a copy needed, is said only when it failed.
 */
export function jobStatus(p: { total: number; done: number; failed: { name: string; reason: string }[]; waiting: number; skipped: number;
  writes: JobWriteView[]; direction: 'to' | 'from' }, board: string): { line: string; finished: boolean } {
  const loud = p.writes.filter((w) => !w.quiet);
  const running = loud.find((w) => w.status === 'running') ?? (p.waiting === 0 ? loud.find((w) => w.status === 'waiting') : undefined);
  if (running) {
    const so = running.kind === 'delete' && running.removed > 0 ? ` removed ${running.removed} so far` : '';
    return { line: `${RUNNING[running.kind] ?? 'Changing'} ${running.label} on ${board}…${so}`, finished: false };
  }
  if (p.waiting > 0) {
    const n = Math.min(p.done + p.failed.length + p.skipped + 1, p.total);
    return { line: `Copying ${n} of ${p.total} ${p.direction === 'to' ? 'to' : 'from'} ${board}…`, finished: false };
  }
  if (p.writes.some((w) => w.status === 'waiting' || w.status === 'running')) {
    return { line: `Changing the disks of ${board}…`, finished: false };
  }
  const parts: string[] = [];
  if (p.total > 0) {
    const [first, ...more] = p.failed;
    const failed = first ? `, ${p.failed.length} failed: ${first.name}: ${first.reason}${more.length ? '; …' : ''}` : '';
    const skipped = p.skipped ? `, skipped ${p.skipped} (already there)` : '';
    parts.push(p.direction === 'to' ? `Copied ${p.done} to ${board}${skipped}${failed}` : `Copied ${p.done}${failed}`);
  }
  const ok = loud.filter((w) => w.status === 'done' && !w.kept);
  const byKind = new Map<string, JobWriteView[]>();
  for (const w of ok) byKind.set(w.kind, [...(byKind.get(w.kind) ?? []), w]);
  for (const [kind, list] of byKind) parts.push(list.length > 2 ? `${PAST[kind]} ${list.length} items` : list.map(doneWords).join(', '));
  for (const w of p.writes.filter((x) => x.status === 'done' && x.kept)) parts.push(keptWords(w.label));
  for (const w of p.writes.filter((x) => x.status === 'failed')) {
    // A drawer delete that stopped names the entry (Transfer's text, relative to the drawer); DEL 0: nothing removed.
    const rest = w.restIn ? ` — the rest is in ${w.restIn}` : '';
    parts.push((w.kind === 'delete' && w.entry
      ? (w.removed > 0 ? `Removed ${w.removed}, then stopped at ${w.entry}: ${w.reason}` : `${w.label}: stopped at ${w.entry}: ${w.reason}`)
      : `${w.label}: ${w.reason}`) + rest);
  }
  return { line: parts.join(' · ') || 'Done', finished: true };
}

/**
 * What a copy out of a volume asks before it is posted (Task 8 fix rounds 1-2): the server expands each source from the
 * listing of its drawer remembered within 2 minutes (plan P3). Each picked drawer (and, as they are read, its drawers --
 * the caller puts them before the last ask) fresh; a resend after the Clash dialog asks them from memory, as they were
 * just read unless the answer was slow. The source drawer `from` LAST, from memory while it holds, from the Amiga once
 * it has run out: the server checks it first, so it must not run out during the walk (each drawer up to 20 s).
 */
export function asksBeforeCopy(from: string, drawers: string[], resend: boolean): { path: string; fresh: boolean }[] {
  return [...drawers.map((path) => ({ path, fresh: !resend })), { path: from, fresh: false }];
}

/** The first picked source the re-listed source drawer no longer holds, as the Amiga says it; null when all are there. */
export function pickGone(entries: { path: string }[], sources: string[]): string | null {
  const there = new Set(entries.map((e) => e.path.toLowerCase()));
  const gone = sources.find((s) => !there.has(s.toLowerCase()));
  return gone === undefined ? null : `${gone.slice(gone.lastIndexOf('/') + 1)}: Object not found`;
}
