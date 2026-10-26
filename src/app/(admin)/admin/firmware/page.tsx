import { Link } from '@/components/shell/link';
import { listReleasesFull, countReleases, readCurrentRelease } from '@/lib/firmware-releases';
import { adminBoardsByVersion } from '@/lib/admin-queries';
import { fmtSize, fmtTimeUtc } from '@/lib/format';
import { signatureLabel } from '@/lib/firmware-state';
import { isTestBuild } from '@/lib/firmware-github-release';
import {
  FIRMWARE_PAGE_SIZE, clampPage, firmwareRepo, githubReleaseUrl, stripTestPrefix, parseShow, firmwareHref,
  type FirmwareShow,
} from '@/lib/admin-firmware';
import { AdminPageHead, ADMIN_BODY } from '@/components/admin/admin-page-head';
import { PromoteReleaseButton } from '@/components/admin/promote-release-button';
import { PagerLink } from '@/components/admin/pager-link';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Admin · Firmware' };

const PILL = 'rounded-full px-[9px] py-px text-[12px] font-semibold';
const FILTERS: readonly { show: FirmwareShow; label: string; testId: string }[] = [
  { show: 'all', label: 'All', testId: 'fw-filter-all' },
  { show: 'releases', label: 'Releases', testId: 'fw-filter-releases' },
  { show: 'test', label: 'Test builds', testId: 'fw-filter-test' },
];

/**
 * Publishing happens from the operator's Mac, because the signing key is there (spec D3) -- a browser publish would
 * either skip the signature or need the key uploaded, and uploading it is the one thing that makes an offline key
 * pointless.
 *
 * The one write here is Promote to release (A7 spec §3): a notes edit on a TEST build, through
 * POST /api/admin/firmware/[id]/promote. Notes are not part of the signed manifest, so the signature stays valid;
 * the route calls requireSuperAdmin() itself, as every /api/admin route does. The (admin) layout's
 * requireSuperAdmin() guards this page.
 *
 * `?show=` filters on the server (C6 Ruling 27): a client filter over a 25-row page would hide releases on other
 * pages. The pager counts the filtered rows and keeps the filter; the subtitle's total is the whole registry.
 */
export default async function AdminFirmwarePage({
  searchParams,
}: {
  // Next 16: searchParams is a Promise. Do NOT import PageProps -- it is ambient.
  searchParams: Promise<{ page?: string | string[]; show?: string | string[] }>;
}) {
  const sp = await searchParams;
  const show = parseShow(sp.show);
  const [total, shown, current] = await Promise.all([
    countReleases(), show === 'all' ? Promise.resolve(null) : countReleases({ show }), readCurrentRelease(),
  ]);
  const pages = Math.max(1, Math.ceil((shown ?? total) / FIRMWARE_PAGE_SIZE));
  const page = clampPage(sp.page, pages);
  const releases = await listReleasesFull({
    limit: FIRMWARE_PAGE_SIZE, offset: (page - 1) * FIRMWARE_PAGE_SIZE, show,
  });
  const boards = await adminBoardsByVersion(releases.map((r) => r.version));
  const repo = firmwareRepo();
  const subtitle = total === 0
    ? 'No releases published · nothing to compare devices against'
    : `${total} published · ${current ? `current ${current.version}` : 'no current release yet'}`;

  return (
    <>
      <AdminPageHead title="Firmware" subtitle={subtitle} />
      <div className={ADMIN_BODY}>
        <div className="flex flex-wrap items-center gap-3">
          <nav aria-label="Show releases" data-testid="fw-filter" className="flex gap-0.5 rounded-[10px] p-[3px]"
               style={{ background: 'var(--surface)', border: '1px solid var(--line)' }}>
            {FILTERS.map((f) => {
              const cur = f.show === show;
              return (
                <Link key={f.show} href={firmwareHref(f.show)} data-testid={f.testId} aria-current={cur ? 'page' : undefined}
                      className={`inline-flex h-8 items-center rounded-[8px] px-3 text-[13px] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--ring) ${cur
                        ? 'bg-(--ink) font-semibold text-(--surface)'
                        : 'font-medium text-(--muted) hover:bg-(--track)'}`}>
                  {f.label}
                </Link>
              );
            })}
          </nav>
          <span className="text-[13px]" style={{ color: 'var(--muted-2)' }}>
            Test builds reach only the bench organizations. Promote to release… offers one to every organization.
          </span>
        </div>

        <section aria-label="Releases" className="flex flex-col gap-2.5">
          {total === 0 ? (
            <div className="rounded-[16px] p-6 text-[13px]" style={{ background: 'var(--surface)', boxShadow: '0 0 0 1px var(--line)', color: 'var(--muted)' }}>
              No releases published yet. Every paired device will read as an{' '}
              <strong>unrecognised build</strong> until there is something to compare it
              against. Build the firmware, then run <code>pnpm firmware:publish</code>.
            </div>
          ) : releases.length === 0 ? (
            <div data-testid="fw-filter-empty" className="rounded-[16px] p-6 text-[13px]"
                 style={{ background: 'var(--surface)', boxShadow: '0 0 0 1px var(--line)', color: 'var(--muted)' }}>
              {show === 'test' ? 'No test builds published.' : 'No releases published.'}
            </div>
          ) : releases.map((r) => {
            const test = isTestBuild(r.notes);
            const github = githubReleaseUrl(r.semver, r.notes, repo);
            const n = boards.get(r.version) ?? 0;
            return (
              <article
                key={r.id}
                data-testid="firmware-release-row"
                data-version={r.version}
                className="flex flex-col gap-2.5 rounded-[16px] px-5 py-4 md:flex-row md:items-start md:gap-5"
                style={{ background: 'var(--surface)', boxShadow: `0 0 0 1px ${r.isCurrent ? 'var(--mounted-line)' : 'var(--line)'}` }}
              >
                <div data-fw-part="left" className="flex shrink-0 flex-col gap-1.5 md:w-[220px]">
                  <span className="flex items-center gap-2 font-mono text-[15px] font-semibold [overflow-wrap:anywhere]" style={{ color: 'var(--ink)' }}>
                    <span aria-hidden className="size-2 shrink-0 rounded-full"
                          style={{ background: r.isCurrent ? 'var(--online-dot)' : test ? 'var(--fetch-dot)' : 'var(--dash)' }} />
                    <span className="min-w-0">{r.version}</span>
                  </span>
                  <span data-fw-meta className="font-mono text-[12px]" style={{ color: 'var(--muted-2)' }}>
                    {`seq ${r.sequence} · ${fmtSize(r.sizeBytes)} · ${fmtTimeUtc(r.publishedAt)}`}
                  </span>
                  {/* Who shipped it, and the signature said out loud rather than implied by a padlock (Ruling 29). */}
                  <span className="text-[12px] [overflow-wrap:anywhere]" style={{ color: 'var(--muted-2)' }}>
                    {`${r.publishedByEmail ?? 'unknown publisher'} · ${signatureLabel(r.signingKeyId, r.signatureFormat)}`}
                  </span>
                </div>
                <div data-fw-part="middle" className="flex min-w-0 flex-1 flex-col gap-1.5">
                  <div className="flex flex-wrap gap-1.5">
                    {r.isCurrent ? (
                      // One pill that holds both ids (Ruling 28): Current keeps its meaning, so does release.
                      <span className={PILL} style={{ background: 'var(--success-bg)', color: 'var(--success-fg)' }}>
                        <span data-testid="fw-tag-current">Current</span> <span data-testid="fw-tag-release">release</span>
                      </span>
                    ) : test ? (
                      <span data-testid="fw-tag-test" className={PILL} style={{ background: 'var(--warning-bg)', color: 'var(--warning-fg)' }}>
                        Test build · bench orgs only
                      </span>
                    ) : (
                      <span data-testid="fw-tag-release" className={PILL} style={{ background: 'var(--track)', color: 'var(--muted)' }}>
                        Release
                      </span>
                    )}
                    {r.security && (
                      <span className={PILL} style={{ background: 'var(--danger-bg)', color: 'var(--danger-strong)' }}>Security</span>
                    )}
                  </div>
                  {r.notes && (
                    <p className="text-[14px] leading-[1.5] [overflow-wrap:anywhere]" style={{ color: 'var(--ink)' }}>{r.notes}</p>
                  )}
                </div>
                <div data-fw-part="right" className="flex shrink-0 flex-col gap-1.5 md:items-end">
                  <span className="text-[12px] tabular-nums" style={{ color: 'var(--muted-2)' }} data-testid="fw-boards">
                    {n} {n === 1 ? 'board' : 'boards'}
                  </span>
                  <PromoteReleaseButton id={r.id} version={r.version} initialNotes={stripTestPrefix(r.notes ?? '')}
                                        canPromote={test} refreshOnDone={show !== 'test'} />
                  {github && (
                    <a href={github} target="_blank" rel="noopener noreferrer" data-testid="fw-github"
                       className="text-[13px] font-semibold text-(--amber-text) hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--ring)">
                      GitHub release
                    </a>
                  )}
                </div>
              </article>
            );
          })}
        </section>

        {/* The board's "load as you scroll" is not built (Ruling 27): admin-firmware pins Page N of M. */}
        <div data-testid="fw-pager" className="flex items-center gap-2.5 text-[13px]">
          <PagerLink href={page > 1 ? firmwareHref(show, page - 1) : null} label="Newer" testId="fw-page-newer" />
          <span style={{ color: 'var(--muted)' }}>Page {page} of {pages}</span>
          <PagerLink href={page < pages ? firmwareHref(show, page + 1) : null} label="Older" testId="fw-page-older" />
        </div>
      </div>
    </>
  );
}
