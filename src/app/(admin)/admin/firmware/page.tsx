import { Link } from '@/components/shell/link';
import { listReleasesFull, countReleases, readCurrentRelease } from '@/lib/firmware-releases';
import { adminBoardsByVersion } from '@/lib/admin-queries';
import { PageHeader } from '@/components/shell/page-header';
import { PromoteReleaseButton } from '@/components/admin/promote-release-button';
import { fmtSize, fmtTimeUtc } from '@/lib/format';
import { signatureLabel } from '@/lib/firmware-state';
import { isTestBuild } from '@/lib/firmware-github-release';
import {
  FIRMWARE_PAGE_SIZE, clampPage, firmwareRepo, githubReleaseUrl, stripTestPrefix,
} from '@/lib/admin-firmware';

export const dynamic = 'force-dynamic';

/**
 * Publishing happens from the operator's Mac, because the signing key is there
 * (spec D3) -- a browser publish would either skip the signature or need the
 * key uploaded, and uploading it is the one thing that makes an offline key
 * pointless.
 *
 * The one write here is Promote to release (A7 spec §3): a notes edit on a
 * TEST build, through POST /api/admin/firmware/[id]/promote. Notes are not
 * part of the signed manifest, so the signature stays valid; the route calls
 * requireSuperAdmin() itself, as every /api/admin route does. The (admin)
 * layout's requireSuperAdmin() guards this page.
 */
export default async function AdminFirmwarePage({
  searchParams,
}: {
  // Next 16: searchParams is a Promise. Do NOT import PageProps -- it is ambient.
  searchParams: Promise<{ page?: string | string[] }>;
}) {
  const [total, current] = await Promise.all([countReleases(), readCurrentRelease()]);
  const pages = Math.max(1, Math.ceil(total / FIRMWARE_PAGE_SIZE));
  const page = clampPage((await searchParams).page, pages);
  const releases = await listReleasesFull({
    limit: FIRMWARE_PAGE_SIZE, offset: (page - 1) * FIRMWARE_PAGE_SIZE,
  });
  const boards = await adminBoardsByVersion(releases.map((r) => r.version));
  const repo = firmwareRepo();

  return (
    <>
      <PageHeader
        eyebrow="Admin"
        title="Firmware"
        subtitle={
          total === 0
            ? 'No releases published · nothing to compare devices against'
            : `${total} published · current is ${current?.version ?? 'none (no release yet)'}`
        }
      />
      <div className="flex flex-col gap-2 px-4 pb-10 sm:px-7">
        {total === 0 ? (
          <div className="glass-card p-6 text-[13px]" style={{ color: 'var(--muted)' }}>
            No releases published yet. Every paired device will read as an{' '}
            <strong>unrecognised build</strong> until there is something to compare it
            against. Build the firmware, then run <code>pnpm firmware:publish</code>.
          </div>
        ) : (
          releases.map((r) => {
            const test = isTestBuild(r.notes);
            const github = githubReleaseUrl(r.semver, r.notes, repo);
            const n = boards.get(r.version) ?? 0;
            return (
              <div
                key={r.id}
                className="glass-card flex flex-col gap-1 p-4"
                data-testid="firmware-release-row"
                data-version={r.version}
              >
                <div className="flex flex-wrap items-baseline gap-2">
                  <span className="break-all font-mono text-[13px]" style={{ color: 'var(--ink)' }}>
                    {r.version}
                  </span>
                  {r.isCurrent && <Tag testId="fw-tag-current" color="var(--accent-blue)">Current</Tag>}
                  {test
                    ? <Tag testId="fw-tag-test" color="var(--muted)">Test</Tag>
                    : <Tag testId="fw-tag-release" color="var(--ink)">Release</Tag>}
                  {r.security && <Tag color="var(--amber-text)">Security</Tag>}
                  <span className="text-[12px] tabular-nums" style={{ color: 'var(--muted)' }} data-testid="fw-boards">
                    {n} {n === 1 ? 'board' : 'boards'}
                  </span>
                  {github && (
                    <a
                      href={github}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-[12px] font-medium underline"
                      style={{ color: 'var(--accent-blue)' }}
                      data-testid="fw-github"
                    >
                      GitHub
                    </a>
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
                    // Format 1 was recorded but never verified by anything
                    // (spec §4) and still says so; format 2 is checked by the
                    // board before it flashes (2b). Said out loud rather than
                    // implied by a padlock.
                    signatureLabel(r.signingKeyId, r.signatureFormat),
                  ].join(' · ')}
                </span>
                {r.notes && (
                  <span className="text-[13px]" style={{ color: 'var(--ink)' }}>
                    {r.notes}
                  </span>
                )}
                <PromoteReleaseButton
                  id={r.id}
                  version={r.version}
                  initialNotes={stripTestPrefix(r.notes ?? '')}
                  canPromote={test}
                />
              </div>
            );
          })
        )}

        <div className="mt-2 flex items-center gap-3 text-[13px]">
          {page > 1 ? (
            <PageLink page={page - 1} testId="fw-page-newer" label="Newer" />
          ) : (
            <Disabled label="Newer" />
          )}
          <span style={{ color: 'var(--on-dark-muted)' }}>Page {page} of {pages}</span>
          {page < pages ? (
            <PageLink page={page + 1} testId="fw-page-older" label="Older" />
          ) : (
            <Disabled label="Older" />
          )}
        </div>
      </div>
    </>
  );
}

function Tag({ children, color, testId }: { children: string; color: string; testId?: string }) {
  return (
    <span
      className="text-[11px] font-semibold uppercase tracking-wide"
      style={{ color }}
      data-testid={testId}
    >
      {children}
    </span>
  );
}

function PageLink({ page, testId, label }: { page: number; testId: string; label: string }) {
  return (
    <Link
      href={`/admin/firmware?page=${page}`}
      className="font-medium"
      style={{ color: 'var(--ink)' }}
      data-testid={testId}
    >
      {label}
    </Link>
  );
}

function Disabled({ label }: { label: string }) {
  return (
    <span className="opacity-40" style={{ color: 'var(--on-dark-muted)' }} aria-disabled="true">
      {label}
    </span>
  );
}
