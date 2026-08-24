'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { hashBlob } from '@/lib/browser-hash';

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

  async function handleFiles(fileList: FileList) {
    setBusy(true);
    const files = [...fileList].filter((f) => /\.(adf|dsk|adz|dms)$/i.test(f.name));

    const hashed: Array<{ file: File; sha256: string }> = [];
    for (const file of files) {
      const sha256 = await hashBlob(file);
      hashed.push({ file, sha256 });
      // If this exact content is already a row (the user dropped it earlier
      // in this same session, before a reload), reset that row in place
      // rather than appending a second one: two rows sharing a sha256 would
      // share a React key, which React logs as a duplicate-key error and
      // may drop or duplicate the row in the DOM. This also has to reach
      // into functional-update state, since the loop can hash faster than
      // React commits each prior setRows call.
      setRows((rs) => {
        const row: Row = { filename: file.name, sizeBytes: file.size, sha256, state: 'hashing' };
        return rs.some((r) => r.sha256 === sha256)
          ? rs.map((r) => (r.sha256 === sha256 ? row : r))
          : [...rs, row];
      });
    }

    const post = (path: string, body: unknown) =>
      fetch(path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }).then((r) => r.json());

    const { missing } = await post('/api/ingest/check', { hashes: hashed.map((h) => h.sha256) });
    const missingSet = new Set<string>(missing);

    for (const h of hashed) {
      if (!missingSet.has(h.sha256)) patch(h.sha256, { state: 'deduped' });
    }

    const toUpload = hashed.filter((h) => missingSet.has(h.sha256));
    const uploadOk = new Map<string, boolean>();
    if (toUpload.length > 0) {
      const { uploads } = await post('/api/ingest/presign', {
        files: toUpload.map((h) => ({ sha256: h.sha256, sizeBytes: h.file.size })),
      });
      // A presigned URL is a credential: it is held only in this in-memory
      // Map, used once as a fetch() target, and never assigned into state,
      // rendered into the DOM, or passed to console/log calls.
      const urlFor = new Map<string, string>(
        (uploads as Array<{ sha256: string; url: string }>).map((u) => [u.sha256, u.url]),
      );

      // Track the PUT outcome locally rather than patching straight to
      // 'done': a row is only truly finished once /complete has written its
      // game/disk rows below, so the mount action it carries (Spec D9)
      // actually refers to something in the catalog. Patching to 'done'
      // here, before /complete has even been called, would let the UI (and
      // anyone -- a test included -- who reacts to that state) race ahead
      // of the write that makes the disk real.
      await Promise.all(
        toUpload.map(async (h) => {
          patch(h.sha256, { state: 'uploading' });
          const res = await fetch(urlFor.get(h.sha256)!, { method: 'PUT', body: h.file });
          uploadOk.set(h.sha256, res.ok);
        }),
      );
    }

    const okToComplete = hashed.filter((h) => uploadOk.get(h.sha256) !== false);
    if (okToComplete.length > 0) {
      await post('/api/ingest/complete', {
        files: okToComplete.map((h) => ({
          sha256: h.sha256,
          sizeBytes: h.file.size,
          filename: h.file.name,
        })),
      });
    }

    setRows((rs) =>
      rs.map((r) => {
        if (r.state === 'uploading' || r.state === 'hashing') {
          return { ...r, state: uploadOk.get(r.sha256) === false ? 'failed' : 'done' };
        }
        return r;
      }),
    );
    setBusy(false);
    router.refresh();
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
                { k: 'scanned', v: scanned, col: 'var(--ink)' },
                { k: 'deduped', v: deduped, col: 'var(--accent-blue)' },
                { k: 'uploaded', v: uploaded, col: 'var(--success-fg)' },
                { k: 'in flight', v: inFlight, col: 'var(--amber-text)' },
                { k: 'failed', v: failed, col: 'var(--danger-fg)' },
              ] as const
            ).map((t) => (
              <div
                key={t.k}
                className="flex flex-col gap-1 rounded-xl p-3.5"
                style={{
                  background: 'var(--glass-panel)',
                  border: '1px solid var(--glass-border)',
                  borderTop: `3px solid ${t.col}`,
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
