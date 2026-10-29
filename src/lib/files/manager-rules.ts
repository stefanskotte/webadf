// The Files manager's small decisions, out of the component so they can be tested (final review of increment 1).
// CLIENT-SAFE: no database import.
import { SIGNED_OUT_TEXT } from '@/lib/signed-out';
import { parsePath } from './path';
import { ZIP_MAX_BYTES, type ClashChoice } from './transfer';
import type { Listing } from './types';
import type { OpItem } from './driver';

/**
 * The disk whose strip a pane shows: the disk its listing is inside, else -- when the listing failed because the
 * image could not be read, not because the place is gone -- the disk its path names. The strip needs no image, and
 * its History and Restore are how such a disk is mended. Null above the disks.
 */
export function stripDiskOf(p: { path: string; listing: Listing | null; error: string | null; gone: boolean }): string | null {
  if (p.listing) return p.listing.disk?.diskId ?? null;
  if (!p.error || p.gone) return null;
  const at = parsePath(p.path);
  return at && at.device === 'LIBRARY' ? at.segments[1] ?? null : null;
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
