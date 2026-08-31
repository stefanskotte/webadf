import { scanStatus } from '@/lib/tosec-sweep';
import { PageHeader } from '@/components/shell/page-header';
import { DatUpload } from '@/components/admin/dat-upload';
import { RunScanButton } from '@/components/admin/run-scan-button';

export const dynamic = 'force-dynamic';

const TILES = [
  { key: 'blobs', label: 'Blobs' },
  { key: 'hashed', label: 'Hashed' },
  { key: 'matched', label: 'Matched' },
  { key: 'none', label: 'No match' },
  { key: 'ambiguous', label: 'Ambiguous' },
  { key: 'unreadable', label: 'Unreadable' },
  { key: 'unchecked', label: 'Unchecked' },
] as const;

export default async function AdminScanPage() {
  const s = await scanStatus();

  // A blob whose bytes could not be read is stamped hashed (so the sweeper
  // does not spin on it forever) with null hashes, and phase 2's short
  // circuit then always files it under match_state = 'none' -- so `none`
  // conflates "TOSEC does not know this disk" with "the object store failed
  // us". Every checked-unreadable blob is counted in both `none` and
  // `unreadable`; subtracting min(unreadable, none) removes exactly that
  // overlap (capped so a still-unchecked unreadable blob, not yet folded
  // into `none`, cannot drive the count negative) without touching the
  // interface scanStatus() already returns.
  const unreadableDecided = Math.min(s.unreadable, s.none);
  const genuineNone = s.none - unreadableDecided;
  const decided = s.matched + s.none + s.ambiguous - unreadableDecided;
  const missRate = decided === 0 ? null : Math.round((genuineNone / decided) * 100);

  return (
    <>
      <PageHeader
        eyebrow="Admin"
        title="Scan"
        subtitle={`${s.tosecEntries} TOSEC entries loaded${missRate === null ? '' : ` · ${missRate}% of decided blobs unmatched`}`}
        actions={<RunScanButton />}
      />
      <div className="px-7 pb-10">
        <div className="mb-3 grid grid-cols-2 gap-3 md:grid-cols-3">
          {TILES.map((t) => (
            <div key={t.key} className="glass-card p-5">
              <div className="text-[12.5px] font-semibold" style={{ color: 'var(--muted)' }}>
                {t.label}
              </div>
              <div
                className="mt-1 text-[30px] font-bold leading-none tracking-[-0.03em]"
                data-testid={`scan-${t.key}`}
              >
                {s[t.key]}
              </div>
            </div>
          ))}
        </div>

        {s.unreadable > 0 && (
          <div className="glass-card mb-3 p-4 text-[13px]" style={{ color: 'var(--amber-text)' }}>
            <strong>{s.unreadable}</strong> blobs could not be read from storage and were stamped
            hashed with no hash -- they will always report as no match, not a genuine TOSEC miss.
          </div>
        )}

        {s.unchecked > 0 && (
          <div className="glass-card mb-3 p-4 text-[13px]" style={{ color: 'var(--muted)' }}>
            <strong>{s.unchecked}</strong> blobs still to process. Each run is bounded and
            resumable — press <strong>Run now</strong> again, or wait for the nightly cron.
          </div>
        )}

        <div className="glass-card mb-3 p-5">
          <DatUpload />
        </div>

        <div className="glass-card overflow-x-auto">
          <table className="w-full text-[13px]">
            <thead>
              <tr style={{ color: 'var(--muted)' }}>
                <th className="px-4 py-3 text-left font-semibold">TOSEC set</th>
                <th className="px-4 py-3 text-left font-semibold">Version</th>
                <th className="px-4 py-3 text-right font-semibold">Entries</th>
              </tr>
            </thead>
            <tbody>
              {s.sets.length === 0 ? (
                <tr>
                  <td className="px-4 py-3" colSpan={3} style={{ color: 'var(--muted)' }}>
                    No DAT sets loaded. Nothing can be matched until one is uploaded.
                  </td>
                </tr>
              ) : (
                s.sets.map((set) => (
                  <tr key={`${set.setName}:${set.setVersion}`} className="border-t"
                      style={{ borderColor: 'rgb(0 0 0 / 0.06)' }}>
                    <td className="px-4 py-3">{set.setName}</td>
                    <td className="px-4 py-3 font-mono text-[12px]" style={{ color: 'var(--muted)' }}>
                      {set.setVersion ?? '—'}
                    </td>
                    <td className="px-4 py-3 text-right tabular-nums">{set.entries}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>
    </>
  );
}
