'use client';
import { useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { toAdf, DISK_IMAGE_PATTERN } from '@/lib/archive/disk-image';
import { hashBlob } from '@/lib/browser-hash';
import { mapLimit } from '@/lib/pool';
import {
  classifyUpload, isExpiredPresign, isUploadableSize, describeUnuploadableSize,
  splitBatches, MAX_HFE_PER_BATCH, type UploadOutcome,
} from '@/lib/blob-upload';
import { inspectHfe, describeInspection } from '@/lib/hfe/inspect';
import { isHfeFilename } from '@/lib/disk-format';
import type { Suggestion } from '@/lib/disk-set-suggest';
import { SetSuggestion } from './set-suggestion';
import { UrlFetch, type FetchedRow } from './url-fetch';
import { DropCard, INK_LABEL, INK_STYLE } from './drop-card';
import { useStaging } from './staging-provider';
import { upsertLibRows, type LibRow, type LibState } from '@/lib/upload-staging';

/** disk-sets spec §3 / the suggest route's own zod cap. */
const MAX_SUGGEST_HASHES = 32;

type RowState = LibState;
type Title = { gameId: string; title: string };

/** A library row's key in the staging list (spec 2026-10-23 §4): its sha256, or `bad:<filename>` before hashing. */
const libKey = (sha: string) => `lib:${sha}`;

/** A new library row. Its `at` is the drop time the list sorts by. A dropped .dms that cannot be decoded has to SAY
 *  so in its note: silently dropping it from the list is how the old behaviour looked -- the file appeared to upload
 *  and then could never be mounted. */
function newRow(name: string, sizeBytes: number, sha: string, state: RowState, note?: string, title: Title | null = null): LibRow {
  return { source: 'lib', key: libKey(sha), kind: 'lib', name, sizeBytes, state, note, title, at: Date.now() };
}

// The check/presign/complete endpoints cap a batch at 500 items (see
// MAX_BATCH in src/lib/ingest.ts, enforced by Zod .max()). A real collection
// is ~18,000 disks, so dropping more than 500 in one go is an everyday
// action, not an edge case -- this MUST match the server's cap or a batch
// this client thinks is fine will 400.
//
// Not imported from src/lib/ingest.ts: that module does `import { createHash
// } from 'node:crypto'` for stableId(), which is server-only and has no
// browser build. Importing it here would pull node:crypto into the client
// bundle. cli/src/index.ts hits the same constraint from the other
// direction and independently defines its own `const BATCH = 500`; this
// mirrors that rather than sharing an import.
const MAX_BATCH = 500;

// Simultaneous PUTs straight to Blob. This was an unbounded Promise.all over
// the whole group: 500 concurrent ~880 KB uploads is ~440 MB in flight from
// one browser tab. Matches the CLI's pLimit(6) so the two clients put the
// same load on the store.
const UPLOAD_CONCURRENCY = 6;

export function Dropzone() {
  const router = useRouter();
  const { setLibRows, refreshNow } = useStaging();
  const [busy, setBusy] = useState(false);
  const [suggestion, setSuggestion] = useState<Suggestion>(null);

  // The state each sha256 last settled into, kept alongside the staging rows
  // rather than read back from them: handleFiles's loop can out-run React's
  // commits (see the hashing loop's own comment below), so the rows may not
  // yet reflect the last patch() this same call made. This ref always does.
  const finalState = useRef(new Map<string, RowState>());

  const patch = (sha: string, next: Partial<LibRow>) => {
    if (next.state) finalState.current.set(sha, next.state);
    setLibRows((rs) => rs.map((r) => (r.key === libKey(sha) ? { ...r, ...next } : r)));
  };

  // Any non-OK response is thrown, never returned as if it were data. The
  // previous shape (`return fetch(...).then((r) => r.json())`) let a 400 --
  // e.g. from sending more than MAX_BATCH hashes in one /check call --
  // destructure as `{ missing: undefined }`. `new Set(undefined)` is empty,
  // so `!missingSet.has(sha256)` was true for every file: the whole batch
  // silently reported "deduped" while nothing had actually been checked,
  // uploaded, or catalogued. Throwing here makes that failure impossible to
  // mistake for success, for this or any other 4xx/5xx.
  async function post(path: string, body: unknown) {
    const res = await fetch(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      throw new Error(`${path} -> ${res.status} ${await res.text()}`);
    }
    return res.json();
  }

  // /complete's own failure shape: a batch that is refused ENTIRELY (every
  // file rejected -- e.g. a lone v3 HFE) answers 409 with a real, structured
  // result -- { created: 0, rejected, rejectedReasons } -- not a transport
  // failure. post()'s throw-on-non-OK would surface that as a plain error
  // before the per-file rejectedReasons handling below ever ran: a refused
  // row that had already been marked 'deduped' would keep showing
  // 'deduped', and the rest would land 'failed' with no note -- a refusal
  // that reads as success, or as an unexplained failure. This treats a 409
  // whose body actually has rejectedReasons as data, same as the 200 case,
  // so every refusal in the batch reaches its row. Any other /complete
  // failure -- network error, 400, 503, a 409 that doesn't look like this --
  // still throws, matching post()'s behaviour for every other endpoint.
  async function postComplete(body: unknown): Promise<{ rejectedReasons?: Record<string, string>; titles?: Record<string, Title> }> {
    const res = await fetch('/api/ingest/complete', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (res.ok) return res.json();
    const text = await res.text();
    if (res.status === 409) {
      try {
        const data = JSON.parse(text);
        if (data && typeof data === 'object' && data.rejectedReasons) return data;
      } catch {
        // Not the structured shape -- fall through to the same throw as
        // any other non-OK response.
      }
    }
    throw new Error(`/api/ingest/complete -> ${res.status} ${text}`);
  }

  // One PUT attempt straight to Blob. Never logs, stores or renders `url` --
  // a presigned URL is a credential, and it exists only as this argument.
  async function putOnce(url: string, file: File) {
    const res = await fetch(url, { method: 'PUT', body: file });
    // The body is read only on failure, and only to classify it.
    const body = res.ok ? '' : await res.text().catch(() => '');
    return {
      outcome: classifyUpload(res.status, res.ok, body),
      expired: isExpiredPresign(res.status),
    };
  }

  // Fresh URL for one file whose presign expired mid-batch. Returns null if
  // even that fails, so the caller can mark just this file failed.
  async function represign(h: { file: File; sha256: string }): Promise<string | null> {
    try {
      const { uploads } = await post('/api/ingest/presign', {
        files: [{ sha256: h.sha256, sizeBytes: h.file.size }],
      });
      return (uploads as Array<{ sha256: string; url: string }>)[0]?.url ?? null;
    } catch {
      return null;
    }
  }

  // Processes one chunk (<= MAX_BATCH items) through check -> presign ->
  // upload -> complete. Kept separate from handleFiles so a batch larger
  // than MAX_BATCH can be split into several of these without any one call
  // exceeding the server's per-request cap -- mirrors the loop in
  // cli/src/index.ts, so the browser and the CLI hit the API identically.
  async function processGroup(group: Array<{ file: File; sha256: string }>) {
    const groupShas = new Set(group.map((h) => h.sha256));
    try {
      const { missing } = await post('/api/ingest/check', {
        hashes: group.map((h) => h.sha256),
      });
      const missingSet = new Set<string>(missing);

      for (const h of group) {
        if (!missingSet.has(h.sha256)) patch(h.sha256, { state: 'deduped' });
      }

      const toUpload = group.filter((h) => missingSet.has(h.sha256));
      const uploadOk = new Map<string, boolean>();

      if (toUpload.length > 0) {
        const { uploads } = await post('/api/ingest/presign', {
          files: toUpload.map((h) => ({ sha256: h.sha256, sizeBytes: h.file.size })),
        });
        // A presigned URL is a credential: it is held only in this
        // in-memory Map, used once as a fetch() target, and never assigned
        // into state, rendered into the DOM, or passed to console/log
        // calls.
        const urlFor = new Map<string, string>(
          (uploads as Array<{ sha256: string; url: string }>).map((u) => [u.sha256, u.url]),
        );

        // Bounded rather than Promise.all over the whole group -- see
        // UPLOAD_CONCURRENCY.
        await mapLimit(toUpload, UPLOAD_CONCURRENCY, async (h) => {
          patch(h.sha256, { state: 'uploading' });
          // Caught per-file rather than left to reject: a hard network
          // failure here (not a non-2xx -- an actual fetch rejection) must
          // not throw out of handleFiles before /complete, the final
          // row updates, and setBusy(false) ever run. That used to wedge every
          // row on "uploading" forever with no visible error and no way to
          // recover short of a reload. Now a failure is scoped to just this
          // file: it is marked 'failed' and every other row keeps going.
          let outcome: UploadOutcome;
          try {
            const first = await putOnce(urlFor.get(h.sha256)!, h.file);
            outcome = first.outcome;
            if (first.expired) {
              // A 403 is an expired presigned URL (1 h TTL), not a bad file.
              // Ask for a fresh one for this single file and try once more.
              // Only a 403 retries: re-PUTting an over-size or otherwise
              // rejected file would just fail again more slowly.
              const fresh = await represign(h);
              if (fresh) outcome = (await putOnce(fresh, h.file)).outcome;
            }
          } catch {
            outcome = 'failed';
          }
          // 'already-stored' counts as OK on purpose: the bytes are in the
          // store, so this file MUST still reach /complete or its blobs row
          // never gets written and it stays wedged forever. See
          // isBlobAlreadyExists in src/lib/blob-upload.ts.
          uploadOk.set(h.sha256, outcome !== 'failed');
        });

        for (const h of toUpload) {
          if (uploadOk.get(h.sha256) === false) patch(h.sha256, { state: 'failed' });
        }
      }

      // /complete is only told about deduped + successfully-uploaded files.
      // A row is only truly finished once /complete has written its
      // game/disk rows, so the mount action it carries (Spec D9) refers to
      // something real -- patching to 'done' any earlier (e.g. right after
      // the PUT) would let the UI race ahead of the write that makes the
      // disk real.
      const okToComplete = group.filter((h) => uploadOk.get(h.sha256) !== false);
      if (okToComplete.length > 0) {
        const res = await postComplete({
          files: okToComplete.map((h) => ({
            sha256: h.sha256,
            sizeBytes: h.file.size,
            filename: h.file.name,
          })),
        });
        const refused = res.rejectedReasons ?? {};
        // The title each placed (or already placed) disk is in; a refused file has none, so its row offers no Open title.
        const titles = res.titles ?? {};
        for (const h of okToComplete) {
          if (refused[h.sha256]) patch(h.sha256, { state: 'failed', note: refused[h.sha256] });
          else if (titles[h.sha256]) patch(h.sha256, { title: titles[h.sha256] });
        }
        for (const h of toUpload) {
          if (uploadOk.get(h.sha256) !== false && !refused[h.sha256]) patch(h.sha256, { state: 'done' });
        }
      }
    } catch (err) {
      // check/presign/complete failed outright (network error, or a 4xx/5xx
      // now surfaced by post() throwing instead of silently destructuring
      // to undefined). Whatever in this group never resolved to a terminal
      // state must not be left showing "hashing"/"uploading" forever --
      // mark it failed so the failure is visible, matching the per-file PUT
      // handling above.
      console.error('ingest batch failed', err);
      const groupKeys = new Set([...groupShas].map(libKey));
      setLibRows((rs) =>
        rs.map((r) =>
          groupKeys.has(r.key) && (r.state === 'hashing' || r.state === 'uploading')
            ? { ...r, state: 'failed' }
            : r,
        ),
      );
    }
  }

  async function handleFiles(fileList: FileList) {
    // Recorded before anything else, so it covers every row this drop ends
    // up producing -- the suggest route refuses a `since` more than 24h old
    // (Task 6 controller ruling 2), which this drop's own start never is.
    const since = new Date().toISOString();
    // This drop's own webkitRelativePath per sha256 ('' on a plain drop, so
    // never recorded then -- disk-set-suggest.ts's folderOf() treats an
    // absent path the same as a plain drop).
    const dropPaths = new Map<string, string>();
    // Every sha256 this drop actually hashed (never the synthetic `bad:...`
    // ids used for a row that failed before hashing), collected here rather
    // than read back from the staging rows afterwards -- see finalState's own
    // comment above for why.
    const dropShas: string[] = [];
    setBusy(true);
    // A new drop clears any earlier panel at once, whether or not this one
    // ends up suggesting anything of its own.
    setSuggestion(null);
    try {
      const dropped = [...fileList].filter((f) => DISK_IMAGE_PATTERN.test(f.name));

      const hashed: Array<{ file: File; sha256: string }> = [];
      for (const original of dropped) {
        let file: File;
        let note: string | undefined;
        if (isHfeFilename(original.name)) {
          // Stored as uploaded (HFE spec D1) -- never through toAdf. Checked
          // here so a refusal is on the row at once; /complete checks again,
          // because the CLI never runs this.
          const r = inspectHfe(new Uint8Array(await original.arrayBuffer()));
          if (!r.ok) {
            setLibRows((rs) => upsertLibRows(rs, [newRow(original.name, original.size, `bad:${original.name}`, 'failed', r.reason)]));
            continue;
          }
          file = original;
          note = describeInspection(r);
        } else {
          // .adz, .dms and .dmz become a plain ADF here, BEFORE hashing -- so the
          // stored blob, its sha256 and its TOSEC identity are identical to
          // those of the same disk uploaded as a .adf. Converting later would
          // give one disk two identities depending on how it arrived.
          const conv = await toAdf(original.name, new Uint8Array(await original.arrayBuffer()));
          if (!conv.ok) {
            setLibRows((rs) => upsertLibRows(rs, [newRow(original.name, original.size, `bad:${original.name}`, 'failed', conv.reason)]));
            continue;
          }
          file = conv.from === 'adf'
            ? original
            : new File([conv.bytes as unknown as BlobPart], conv.name, { type: 'application/octet-stream' });
          note = conv.from === 'adf' ? undefined
            : `from ${original.name}${conv.note ? ` (${conv.note})` : ''}`;
        }
        const sha256 = await hashBlob(file);
        hashed.push({ file, sha256 });
        dropShas.push(sha256);
        if (original.webkitRelativePath) dropPaths.set(sha256, original.webkitRelativePath);
        // If this exact content is already a row (the user dropped it
        // earlier in this visit), reset that row in place rather than
        // appending a second one: two rows sharing a key would share a React
        // key, which React logs as a duplicate-key error and may drop or
        // duplicate the row in the DOM. This also has to reach into
        // functional-update state, since the loop can hash faster than React
        // commits each prior update.
        setLibRows((rs) => upsertLibRows(rs, [newRow(file.name, file.size, sha256, 'hashing', note)]));
      }

      // Screened before batching. /api/ingest/presign rejects a zero-byte or
      // over-size file, and that 400 fails the presign call for the WHOLE
      // group -- one truncated .adf in a dropped folder would take every
      // other file in its batch down with it. Failing just that row keeps
      // the rest of the drop working.
      // The row says why: it used to turn red still wearing the positive HFE
      // note, which reads as a bug rather than as "this file is too big".
      const unusable = hashed.filter((h) => !isUploadableSize(h.file.size));
      for (const h of unusable) {
        patch(h.sha256, { state: 'failed', note: describeUnuploadableSize(h.file.name, h.file.size) });
      }
      const usable = hashed.filter((h) => isUploadableSize(h.file.size));

      // At most MAX_HFE_PER_BATCH HFEs per group: /complete inspects each
      // one inside its 60 s budget and refuses a call carrying more.
      for (const group of splitBatches(usable, (h) => h.file.name, MAX_BATCH, MAX_HFE_PER_BATCH)) {
        await processGroup(group);
      }
    } finally {
      // Runs on every path -- success, a per-group catch, or anything else
      // thrown above -- so the dropzone/input never stays disabled and the
      // library view always reflects whatever did land.
      setBusy(false);
      router.refresh();
      void refreshNow();

      // Fired only after busy/refresh: the suggestion is about what this
      // drop just did, not something that should hold the UI up while it's
      // still uploading. finalState (not the staging rows -- see its own
      // comment) says which of this drop's own sha256s actually landed.
      await suggestFor(dropShas, dropPaths, since);
    }
  }

  // A set suggestion for what one drop (or one URL fetch) just landed.
  // Shared so a .zip fetched from a URL gets the same "these look like one
  // set" panel a dropped folder does.
  async function suggestFor(dropShas: string[], dropPaths: Map<string, string>, since: string) {
    const settled = [...new Set(
      dropShas.filter((sha) => {
        const s = finalState.current.get(sha);
        return s === 'done' || s === 'deduped';
      }),
    )];
    if (settled.length >= 2) {
      // Never more than 32 hashes (Task 6 controller ruling): the route's
      // own zod cap 400s past that, and a larger drop gets no suggestion
      // anyway (disk-sets spec §2).
      const sha256s = settled.slice(0, MAX_SUGGEST_HASHES);
      const paths: Record<string, string> = {};
      for (const sha of sha256s) {
        const p = dropPaths.get(sha);
        if (p) paths[sha] = p;
      }
      try {
        const res = await fetch('/api/disk-sets/suggest', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            sha256s, since,
            ...(Object.keys(paths).length > 0 ? { paths } : {}),
          }),
        });
        // Any non-200, or a null suggestion, is treated identically: no
        // panel. Never surfaced as an error -- the suggestion is a nicety,
        // not part of the upload's own success/failure.
        if (res.ok) {
          const body = (await res.json()) as { suggestion: Suggestion };
          setSuggestion(body.suggestion);
        }
      } catch {
        // Network failure: same as "no suggestion".
      }
    }
  }

  // Rows from /api/ingest/url, merged into the staging list exactly like a
  // drop's: same states, same notes, same reset-in-place for a repeat sha.
  async function addFetchedRows(fetched: FetchedRow[], since: string) {
    const shas: string[] = [];
    const rows = fetched.map((f) => newRow(f.filename, f.sizeBytes, f.sha256 ?? `bad:${f.filename}`, f.state, f.note, f.title ?? null));
    setLibRows((rs) => upsertLibRows(rs, rows));
    for (const f of fetched) {
      if (!f.sha256) continue;
      finalState.current.set(f.sha256, f.state);
      shas.push(f.sha256);
    }
    router.refresh();
    setSuggestion(null);
    await suggestFor(shas, new Map(), since);
  }

  return (
    // The Add-to-library card (src/app/(app)/ingest/page.tsx): drop zone, URL fetch and the set suggestion.
    // What each file did shows in the Staging list below both cards.
    <DropCard testId="dropzone" headingId="add-heading" title="Add disks to the library"
      hint="ADF, ADZ, DMS, DMZ or HFE. Hashed in your browser first — only missing disks upload."
      disk={{ color: 'black', set: 'ADF · ADZ · DMS · HFE', title: 'Add to library' }}
      disabled={busy} onFiles={(f) => void handleFiles(f)}>
      <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center">
        <label htmlFor="add-file-input" data-testid="add-browse" aria-disabled={busy || undefined}
               className={INK_LABEL} style={INK_STYLE}>
          {busy ? 'Working…' : 'Browse files'}
          <input id="add-file-input" type="file" multiple accept=".adf,.dsk,.adz,.dms,.dmz,.hfe" className="sr-only"
                 data-testid="file-input" disabled={busy}
                 onChange={(e) => { const f = e.target.files; if (f) void handleFiles(f); }} />
        </label>
        <UrlFetch busy={busy} setBusy={setBusy} onRows={addFetchedRows} />
      </div>
      {suggestion && <SetSuggestion suggestion={suggestion} onDone={() => setSuggestion(null)} />}
    </DropCard>
  );
}
