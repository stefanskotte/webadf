import { scanStatus } from '@/lib/tosec-sweep';
import { PageHeader } from '@/components/shell/page-header';
import { DatUpload } from '@/components/admin/dat-upload';
import { RunScanButton } from '@/components/admin/run-scan-button';
import { OpenRetroUpload } from '@/components/admin/openretro-upload';

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

const ENRICH_TILES = [
  { key: 'enriched', label: 'Enriched' },
  { key: 'enrichNone', label: 'Not in OpenRetro' },
  { key: 'enrichAmbiguous', label: 'Ambiguous' },
  { key: 'enrichUnchecked', label: 'Unchecked' },
  { key: 'openretroEntries', label: 'OpenRetro entries' },
  { key: 'imagesStored', label: 'Images stored' },
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
  // ...and the same treatment for disks somebody MADE here. They hash to
  // something no DAT contains, so they are stamped 'none' correctly -- but a
  // disk the operator authored is in no preservation set and never will be,
  // so counting it would make this rate fall every time they make one and
  // report their own work as a gap in the archive.
  //
  // Capped against what is left after the unreadable subtraction so the two
  // corrections cannot overlap into a negative count.
  const authoredDecided = Math.min(s.authoredNone, Math.max(0, s.none - unreadableDecided));
  const excluded = unreadableDecided + authoredDecided;
  const genuineNone = s.none - excluded;
  const decided = s.matched + s.none + s.ambiguous - excluded;
  const missRate = decided === 0 ? null : Math.round((genuineNone / decided) * 100);

  return (
    <>
      <PageHeader
        eyebrow="Admin"
        title="Scan"
        subtitle={[
          `${s.tosecEntries} TOSEC entries loaded`,
          missRate === null ? null : `${missRate}% of decided blobs unmatched`,
          // Named rather than silently deducted: a rate that quietly excludes
          // things is a rate nobody can check.
          authoredDecided === 0 ? null : `${authoredDecided} self-made disk${authoredDecided === 1 ? '' : 's'} excluded`,
        ].filter(Boolean).join(' · ')}
        actions={<RunScanButton />}
      />
      <div className="px-4 pb-10 sm:px-7">
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

        <div className="mb-3 grid grid-cols-2 gap-3 md:grid-cols-3">
          {ENRICH_TILES.map((t) => (
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
              {/* The storage cost of copying someone else's images into our
                  own store should be a number on the page, not a surprise
                  on a bill. */}
              {t.key === 'imagesStored' && (
                <div className="mt-1 text-[12px]" style={{ color: 'var(--muted)' }}
                     data-testid="scan-imageMb">
                  {(s.imageBytes / (1024 * 1024)).toFixed(1)} MB
                </div>
              )}
            </div>
          ))}
        </div>

        {s.openretroEntries === 0 && (
          <div className="glass-card mb-3 p-4 text-[13px]" style={{ color: 'var(--muted)' }}>
            No OpenRetro metadata loaded. Nothing can be enriched until an
            <strong> Amiga.sqlite</strong> is uploaded below.
          </div>
        )}

        {s.enrichUnchecked > 0 && s.openretroEntries > 0 && (
          <div className="glass-card mb-3 p-4 text-[13px]" style={{ color: 'var(--muted)' }}>
            <strong>{s.enrichUnchecked}</strong> blobs still to enrich. Image fetching is
            capped per run on purpose, so a first pass over a large library takes several
            runs — or several nights.
          </div>
        )}

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

        <div className="glass-card mb-3 p-5">
          <OpenRetroUpload />
        </div>

        <div className="glass-card overflow-x-auto">
          {/* Three columns, but two of them are long single tokens -- a set
              name like "Commodore Amiga - Games - [ADF]" and a version like
              "TOSEC-v2023-01-08" -- which w-full would wrap to shreds at
              390px instead of letting the card scroll. 640px keeps both on
              one line and still leaves the entry count its own column. */}
          <table className="w-full min-w-[640px] text-[13px]">
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
                    <td className="px-4 py-3 text-right tabular-nums" data-testid="set-entries">
                      {set.entries}
                    </td>
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
