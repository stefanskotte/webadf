import { listReleasesFull } from '@/lib/firmware-releases';
import { PageHeader } from '@/components/shell/page-header';
import { fmtSize, fmtTimeUtc } from '@/lib/format';

export const dynamic = 'force-dynamic';

/**
 * Read-only. Publishing happens from the operator's Mac, because the signing
 * key is there (spec D3) -- a browser publish would either skip the signature
 * or need the key uploaded, and uploading it is the one thing that makes an
 * offline key pointless.
 *
 * The (admin) layout calls requireSuperAdmin(), which is what guards this
 * page; there is no /api/admin/firmware route to guard separately, because
 * pnpm firmware:publish writes through the library directly.
 */
export default async function AdminFirmwarePage() {
  const releases = await listReleasesFull();
  const newest = releases[0];

  return (
    <>
      <PageHeader
        eyebrow="Admin"
        title="Firmware"
        subtitle={
          releases.length === 0
            ? 'No releases published · nothing to compare devices against'
            : `${releases.length} published · current is ${newest.version}`
        }
      />
      <div className="flex flex-col gap-2 px-4 pb-10 sm:px-7">
        {releases.length === 0 ? (
          <div className="glass-card p-6 text-[13px]" style={{ color: 'var(--muted)' }}>
            No releases published yet. Every paired device will read as an{' '}
            <strong>unrecognised build</strong> until there is something to compare it
            against. Build the firmware, then run <code>pnpm firmware:publish</code>.
          </div>
        ) : (
          releases.map((r) => (
            <div
              key={r.id}
              className="glass-card flex flex-col gap-1 p-4"
              data-testid="firmware-release-row"
            >
              <div className="flex flex-wrap items-baseline gap-2">
                <span className="break-all font-mono text-[13px]" style={{ color: 'var(--ink)' }}>
                  {r.version}
                </span>
                {r.security && (
                  <span
                    className="text-[11px] font-semibold uppercase tracking-wide"
                    style={{ color: 'var(--amber-text)' }}
                  >
                    Security
                  </span>
                )}
              </div>
              <span className="break-words text-[11px]" style={{ color: 'var(--muted)' }}>
                {[
                  `seq ${r.sequence}`,
                  fmtSize(r.sizeBytes),
                  fmtTimeUtc(r.publishedAt),
                  // Who shipped it. The column was written on every row and
                  // read by nothing, so a wrong attribution was undetectable.
                  r.publishedByEmail ?? 'unknown publisher',
                  // Recorded but not verified by anything yet (spec §4). Said
                  // out loud here rather than implied by a padlock, so this
                  // page never suggests a check that does not run.
                  `signed ${r.signingKeyId} (unverified)`,
                ].join(' · ')}
              </span>
              {r.notes && (
                <span className="text-[13px]" style={{ color: 'var(--ink)' }}>
                  {r.notes}
                </span>
              )}
            </div>
          ))
        )}
      </div>
    </>
  );
}
