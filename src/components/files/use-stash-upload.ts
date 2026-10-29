'use client';

import { useState } from 'react';
import { hashBlob } from '@/lib/browser-hash';
import { mapLimit } from '@/lib/pool';
import { putPresigned } from '@/lib/blob-upload';
import { planStashBatches, type StashDropRefusal } from '@/lib/files/stash-paths';
import { refusalWords } from '@/lib/files/words';
import type { DroppedItem } from '@/lib/drop-reader';
import type { OnClash, OpItem } from '@/lib/files/driver';
import type { RefusalCode } from '@/lib/files/types';
import type { Clash } from './dialogs';

/**
 * Files from the computer into a STASH: folder (Files spec 2026-10-29 §4.2, R6): each file hashed in the browser, the
 * blobs the store lacks PUT by presigned URL, then one commit per batch, where the server verifies size and sha-256 and
 * writes the rows. The drop is split by planStashBatches (a folder travels whole; ≤ 64 MB and ≤ 200 entries a commit).
 */

/** Simultaneous PUTs, as the library dropzone and the CLI bound them. */
const UPLOAD_CONCURRENCY = 6;
/** Files hashed at once: each is read whole (up to 20 MB) to hash it. */
const HASH_CONCURRENCY = 4;
/** = stash-commit.ts's NOT_WHOLE: the server released bytes that were not this file's; the item is tried once more. */
const NOT_WHOLE = 'upload did not arrive whole';

const PLAN_WORDS: Record<StashDropRefusal, string> = {
  too_large: 'over 20 MB — STASH: takes up to 20 MB a file',
  folder_too_large: 'Drop folders of up to 64 MB at a time',
  folder_too_many: 'Drop folders of up to 200 items at a time',
};

export type StashRefused = { path: string; why: string };
export type StashUploadResult = {
  /** One per top-level item the server answered for (OpItem's `source` is the top's name). */
  items: OpItem[];
  /** Names the server stored differently: cleaned for the Amiga (R3) or keep-both (R4). */
  renamed: { from: string; to: string }[];
  /** What never reached a commit, in words: planned out, or its upload failed. */
  refused: StashRefused[];
  /** The words of a refusal that stopped the drop (STASH: full, a failed request); null when it ran to the end. */
  stopped: string | null;
  /** The server found clashes the client did not know of (a race): nothing of `rest` was written. */
  clashes?: Clash[];
  rest?: DroppedItem[];
};

/** A refusal the hook has already put in words (a presign the server refused). */
class Refusal extends Error {}

const topOf = (path: string) => path.split('/').filter(Boolean)[0] ?? path;

function words(code: unknown, detail: unknown): string {
  const d = typeof detail === 'string' ? detail : undefined;
  return (typeof code === 'string' && refusalWords(code as RefusalCode, d)) || refusalWords('failed');
}

async function postJson(path: string, body: unknown): Promise<{ ok: boolean; status: number; data: Record<string, unknown> | null }> {
  const res = await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const data = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  return { ok: res.ok, status: res.status, data };
}

/** Upload URLs for `files` (non-empty, one per sha-256: ruling 15); a sha the store already holds gets none. */
async function presign(files: { sha256: string; sizeBytes: number }[]): Promise<Map<string, string>> {
  const unique = [...new Map(files.map((f) => [f.sha256, f])).values()];
  if (!unique.length) return new Map();
  const r = await postJson('/api/files/stash/presign', { files: unique });
  if (!r.ok) throw new Refusal(words(r.data?.error, r.data?.detail));
  return new Map((r.data?.uploads as { sha256: string; url: string }[]).map((u) => [u.sha256, u.url]));
}

/** What a top that never reached a commit says when a refusal stopped the drop before it. */
const NOT_SENT = 'not sent — the drop stopped';

/**
 * `items` into the STASH: folder `dir` (a path, "STASH:" or "STASH:/Mods"). With `onClash: 'ask'` a clash the server
 * finds stops the drop before that batch: the result carries `clashes` and the items not yet written (`rest`), to be
 * sent again with the chosen answer. A refusal that stops the drop lists every top it left unwritten. `progress` hears
 * "Reading 3 of 12…" as files are hashed, then "Uploading 3 of 12…" as they go up. The hook's work, apart from React so it can be tested with a mocked fetch.
 */
export async function uploadToStash(dir: string, items: DroppedItem[], onClash: OnClash, progress: (words: string) => void = () => {})
  : Promise<StashUploadResult> {
  const out: StashUploadResult = { items: [], renamed: [], refused: [], stopped: null };
  const plan = planStashBatches(items);
  out.refused.push(...plan.refused.map((r) => ({ path: r.path, why: PLAN_WORDS[r.why] })));
  const total = plan.batches.flat().filter((i) => i.kind === 'file' && i.sizeBytes > 0).length;
  let moved = 0, read = 0;
  const tick = () => progress(`Uploading ${Math.min(moved, total)} of ${total}…`);
  const sha = new Map<DroppedItem, string>();

  /** Hash, presign and PUT the non-empty files of `batch`; the tops whose bytes did not go up. */
  async function send(batch: DroppedItem[], counted: boolean): Promise<Set<string>> {
    const files = batch.filter((i): i is DroppedItem & { file: File } => i.kind === 'file' && i.sizeBytes > 0 && !!i.file);
    await mapLimit(files, HASH_CONCURRENCY, async (i) => {
      if (sha.has(i)) return;
      sha.set(i, await hashBlob(i.file));
      if (counted) progress(`Reading ${Math.min(++read, total)} of ${total}…`);
    });
    const urls = await presign(files.map((i) => ({ sha256: sha.get(i)!, sizeBytes: i.sizeBytes })));
    const failed = new Set<string>();
    const sent = new Map<string, Promise<boolean>>();   // one PUT per sha-256, however many files share it
    await mapLimit(files, UPLOAD_CONCURRENCY, async (i) => {
      const h = sha.get(i)!;
      const url = urls.get(h);
      if (url && !sent.has(h)) {
        sent.set(h, putPresigned(url, i.file, async () => (await presign([{ sha256: h, sizeBytes: i.sizeBytes }]).catch(() => null))?.get(h) ?? null)
          .then((o) => o !== 'failed', () => false));
      }
      if (url && !(await sent.get(h))) failed.add(topOf(i.path).toLowerCase());
      if (counted) { moved++; tick(); }
    });
    return failed;
  }

  async function commit(batch: DroppedItem[], clash: OnClash) {
    return postJson('/api/files/stash/commit', {
      dir, onClash: clash,
      entries: batch.map((i) => ({
        path: i.path, kind: i.kind, sizeBytes: i.kind === 'file' ? i.sizeBytes : 0,
        ...(i.kind === 'file' && i.sizeBytes > 0 ? { sha256: sha.get(i) } : {}),
        ...(i.file?.lastModified ? { lastModified: i.file.lastModified } : {}),
      })),
    });
  }

  // Hashing reads each file whole first: "Reading k of N" until the PUTs start, never "Uploading 0 of N" meanwhile.
  progress(`Reading 0 of ${total}…`);
  // The items of the batch in hand that have no answer yet, and the index of the next batch: what a stop leaves unwritten.
  let pending: DroppedItem[] = [];
  let next = 0;
  try {
    for (; next < plan.batches.length;) {
      const batch = plan.batches[next++];
      pending = batch;
      const failed = await send(batch, true);
      const ready = batch.filter((i) => !failed.has(topOf(i.path).toLowerCase()));
      for (const top of new Set(batch.filter((i) => failed.has(topOf(i.path).toLowerCase())).map((i) => topOf(i.path)))) {
        out.refused.push({ path: top, why: 'the upload failed' });
      }
      pending = ready;
      if (!ready.length) continue;
      const r = await commit(ready, onClash);
      if (r.status === 409 && r.data?.error === 'clashes') {
        return { ...out, clashes: r.data.clashes as Clash[], rest: [...ready, ...plan.batches.slice(next).flat()] };
      }
      if (!r.ok || !r.data?.items) { out.stopped = words(r.data?.error, r.data?.detail); break; }
      let got = r.data.items as OpItem[];
      out.renamed.push(...((r.data.renamed ?? []) as StashUploadResult['renamed']));
      pending = [];
      // The server released bytes that were not this file's (a poisoned key): those tops go up once more. Whatever
      // that retry meets, the first commit's answers (written on the server) are kept.
      const again = new Set(got.filter((i) => !i.ok && i.refusal.code === 'failed' && i.refusal.detail === NOT_WHOLE)
        .map((i) => i.source.toLowerCase()));
      if (again.size) {
        try {
          const retry = ready.filter((i) => again.has(topOf(i.path).toLowerCase()));
          for (const i of retry) sha.delete(i);
          const lost = await send(retry, false);
          const second = retry.filter((i) => !lost.has(topOf(i.path).toLowerCase()));
          const r2 = second.length ? await commit(second, onClash) : null;
          if (r2?.ok && r2.data?.items) {
            const by = new Map((r2.data.items as OpItem[]).map((i) => [i.source.toLowerCase(), i]));
            got = got.map((i) => by.get(i.source.toLowerCase()) ?? i);
            out.renamed.push(...((r2.data.renamed ?? []) as StashUploadResult['renamed']));
          }
        } catch (e) {
          out.items.push(...got);
          throw e;
        }
      }
      out.items.push(...got);
    }
  } catch (e) {
    out.stopped = e instanceof Refusal ? e.message : refusalWords('failed');
  }
  if (out.stopped) {
    const left = [...pending, ...plan.batches.slice(next).flat()];
    for (const top of new Set(left.map((i) => topOf(i.path)))) out.refused.push({ path: top, why: NOT_SENT });
  }
  return out;
}

export function useStashUpload() {
  const [busy, setBusy] = useState<string | null>(null);

  async function upload(dir: string, items: DroppedItem[], onClash: OnClash): Promise<StashUploadResult> {
    try {
      return await uploadToStash(dir, items, onClash, setBusy);
    } finally {
      setBusy(null);
    }
  }

  return { busy, setBusy, upload };
}
