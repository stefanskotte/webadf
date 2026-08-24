'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { hashBlob } from '@/lib/browser-hash';
import { chunk } from '@/lib/chunk';
import { mapLimit } from '@/lib/pool';
import {
  classifyUpload, isExpiredPresign, isUploadableSize, type UploadOutcome,
} from '@/lib/blob-upload';

type RowState = 'hashing' | 'deduped' | 'uploading' | 'done' | 'failed';

type Row = {
  filename: string;
  sizeBytes: number;
  sha256: string;
  state: RowState;
};

const STATE_COLOR: Record<RowState, string> = {
  failed: 'var(--danger-fg)',
  deduped: 'var(--accent-blue)',
  done: 'var(--success-fg)',
  // 'hashing' and 'uploading' are the in-flight states. --accent-amber is a
  // FILL-only colour (fails WCAG AA as text) -- amber text must always use
  // --amber-text instead.
  hashing: 'var(--amber-text)',
  uploading: 'var(--amber-text)',
};

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

// Finished rows carry the mount action (Spec D9): the fast path is
// drop -> click -> play, so a row whose bytes are safely stored -- whether
// freshly uploaded or already known -- should offer to mount immediately.
// Mounting itself lands in a later plan, so the control is rendered
// disabled with an honest label rather than a button that looks live and
// does nothing.
const MOUNTABLE: RowState[] = ['done', 'deduped'];

function MountButton({ state }: { state: RowState }) {
  if (!MOUNTABLE.includes(state)) {
    return <span aria-hidden style={{ color: 'var(--faint)' }}>—</span>;
  }
  return (
    <button
      type="button"
      disabled
      title="Mounting arrives in a later release -- this disk is stored and will be playable from here."
      aria-label="Mount, coming soon"
      className="ml-auto flex items-center gap-1 rounded-md px-2 py-1 text-[10px] font-semibold uppercase tracking-wide"
      style={{
        background: 'rgb(22 39 58 / 0.35)',
        color: 'rgb(238 243 246 / 0.55)',
        cursor: 'not-allowed',
      }}
    >
      Mount — soon
    </button>
  );
}

export function Dropzone() {
  const router = useRouter();
  const [rows, setRows] = useState<Row[]>([]);
  const [busy, setBusy] = useState(false);

  const patch = (sha: string, next: Partial<Row>) =>
    setRows((rs) => rs.map((r) => (r.sha256 === sha ? { ...r, ...next } : r)));

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
          // setRows, and setBusy(false) ever run. That used to wedge every
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
        await post('/api/ingest/complete', {
          files: okToComplete.map((h) => ({
            sha256: h.sha256,
            sizeBytes: h.file.size,
            filename: h.file.name,
          })),
        });
        for (const h of toUpload) {
          if (uploadOk.get(h.sha256) !== false) patch(h.sha256, { state: 'done' });
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
      setRows((rs) =>
        rs.map((r) =>
          groupShas.has(r.sha256) && (r.state === 'hashing' || r.state === 'uploading')
            ? { ...r, state: 'failed' }
            : r,
        ),
      );
    }
  }

  async function handleFiles(fileList: FileList) {
    setBusy(true);
    try {
      const files = [...fileList].filter((f) => /\.(adf|dsk|adz|dms)$/i.test(f.name));

      const hashed: Array<{ file: File; sha256: string }> = [];
      for (const file of files) {
        const sha256 = await hashBlob(file);
        hashed.push({ file, sha256 });
        // If this exact content is already a row (the user dropped it
        // earlier in this same session, before a reload), reset that row in
        // place rather than appending a second one: two rows sharing a
        // sha256 would share a React key, which React logs as a
        // duplicate-key error and may drop or duplicate the row in the DOM.
        // This also has to reach into functional-update state, since the
        // loop can hash faster than React commits each prior setRows call.
        setRows((rs) => {
          const row: Row = { filename: file.name, sizeBytes: file.size, sha256, state: 'hashing' };
          return rs.some((r) => r.sha256 === sha256)
            ? rs.map((r) => (r.sha256 === sha256 ? row : r))
            : [...rs, row];
        });
      }

      // Screened before batching. /api/ingest/presign rejects a zero-byte or
      // over-size file, and that 400 fails the presign call for the WHOLE
      // group -- one truncated .adf in a dropped folder would take every
      // other file in its batch down with it. Failing just that row keeps
      // the rest of the drop working.
      const unusable = hashed.filter((h) => !isUploadableSize(h.file.size));
      for (const h of unusable) patch(h.sha256, { state: 'failed' });
      const usable = hashed.filter((h) => isUploadableSize(h.file.size));

      for (const group of chunk(usable, MAX_BATCH)) {
        await processGroup(group);
      }
    } finally {
      // Runs on every path -- success, a per-group catch, or anything else
      // thrown above -- so the dropzone/input never stays disabled and the
      // library view always reflects whatever did land.
      setBusy(false);
      router.refresh();
    }
  }

  const scanned = rows.length;
  const deduped = rows.filter((r) => r.state === 'deduped').length;
  const uploaded = rows.filter((r) => r.state === 'done').length;
  const inFlight = rows.filter((r) => r.state === 'hashing' || r.state === 'uploading').length;
  const failed = rows.filter((r) => r.state === 'failed').length;

  return (
    <div className="mx-7 flex flex-col gap-4">
      <label
        data-testid="dropzone"
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => {
          e.preventDefault();
          void handleFiles(e.dataTransfer.files);
        }}
        className="glass-card flex h-48 cursor-pointer flex-col items-center justify-center gap-3"
        style={{ borderStyle: 'dashed', borderColor: 'rgb(245 130 46 / 0.55)' }}
      >
        <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="var(--accent-amber)" strokeWidth="1.4">
          <path d="M12 16V4m0 0L8 8m4-4 4 4" />
          <path d="M3 16v3a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-3" />
        </svg>
        <span className="text-[15px] font-semibold" style={{ color: 'var(--ink)' }}>
          Drop ADF or DSK files
        </span>
        <span className="font-mono text-[10.5px]" style={{ color: 'var(--muted-2)' }}>
          hashed in your browser before upload
        </span>
        <span
          className="flex h-[34px] items-center rounded-lg px-4 text-[13px] font-medium"
          style={{ background: '#fff', border: '1px solid var(--hairline-strong)', boxShadow: 'var(--shadow-card)' }}
        >
          Browse…
        </span>
        <input
          type="file"
          multiple
          accept=".adf,.dsk,.adz,.dms"
          className="sr-only"
          data-testid="file-input"
          disabled={busy}
          onChange={(e) => e.target.files && void handleFiles(e.target.files)}
        />
      </label>

      {rows.length > 0 && (
        <>
          <div className="grid grid-cols-5 gap-3">
            {(
              [
                { k: 'scanned', v: scanned, col: 'var(--ink)', border: 'var(--ink)' },
                { k: 'deduped', v: deduped, col: 'var(--accent-blue)', border: 'var(--accent-blue)' },
                { k: 'uploaded', v: uploaded, col: 'var(--success-fg)', border: 'var(--success-fg)' },
                // Border is a fill, not text, so it can use the brighter
                // --accent-amber (matching design/Ingest.dc.html's tile);
                // the number itself stays on --amber-text for AA contrast.
                { k: 'in flight', v: inFlight, col: 'var(--amber-text)', border: 'var(--accent-amber)' },
                { k: 'failed', v: failed, col: 'var(--danger-fg)', border: 'var(--danger-fg)' },
              ] as const
            ).map((t) => (
              <div
                key={t.k}
                className="flex flex-col gap-1 rounded-xl p-3.5"
                style={{
                  background: 'var(--glass-panel)',
                  border: '1px solid var(--glass-border)',
                  borderTop: `3px solid ${t.border}`,
                  backdropFilter: 'blur(12px)',
                  boxShadow: 'var(--shadow-card)',
                }}
              >
                <span
                  className="font-mono text-[9.5px] uppercase tracking-wide"
                  style={{ color: 'var(--muted-2)' }}
                >
                  {t.k}
                </span>
                <span className="text-2xl font-bold leading-tight" style={{ color: t.col }}>
                  {t.v}
                </span>
              </div>
            ))}
          </div>

          <div className="glass-card overflow-hidden">
            <div
              className="flex items-center gap-3 px-4 py-2.5 font-mono text-[11px]"
              style={{ borderBottom: '1px solid var(--hairline)', color: 'var(--muted-2)' }}
            >
              <span className="text-[13.5px] font-semibold" style={{ color: 'var(--ink)', fontFamily: 'inherit' }}>
                This run
              </span>
              <span>
                {scanned} file{scanned === 1 ? '' : 's'} · {inFlight} in flight
              </span>
            </div>

            <div
              className="grid grid-cols-[1fr_90px_100px_90px_120px] items-center px-4 py-1.5 font-mono text-[10px] uppercase tracking-wide"
              style={{ background: 'rgb(255 255 255 / 0.5)', borderBottom: '1px solid var(--hairline)', color: 'var(--muted-2)' }}
            >
              <span>File</span>
              <span className="text-right">Size</span>
              <span className="text-right">SHA-256</span>
              <span className="text-right">State</span>
              <span className="text-right">Mount</span>
            </div>

            <div data-testid="ingest-rows">
              {rows.map((r) => (
                <div
                  key={r.sha256}
                  data-testid="ingest-row"
                  className="grid grid-cols-[1fr_90px_100px_90px_120px] items-center px-4 py-2 font-mono text-[11px]"
                  style={{ borderBottom: '1px solid var(--hairline)' }}
                >
                  <span className="truncate pr-3" style={{ color: 'var(--foreground)' }}>
                    {r.filename}
                  </span>
                  <span className="text-right" style={{ color: 'var(--muted-2)' }}>
                    {Math.round(r.sizeBytes / 1024)} KB
                  </span>
                  <span className="text-right text-[10px]" style={{ color: 'var(--faint)' }}>
                    {r.sha256.slice(0, 8)}…
                  </span>
                  <span
                    className="text-right text-[10px] font-semibold uppercase"
                    data-state={r.state}
                    style={{ color: STATE_COLOR[r.state] }}
                  >
                    {r.state}
                  </span>
                  <div className="flex justify-end">
                    <MountButton state={r.state} />
                  </div>
                </div>
              ))}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
