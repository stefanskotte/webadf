import { Link } from '@/components/shell/link';
import { adminListUsers, adminCountUsers } from '@/lib/admin-queries';
import { PageHeader } from '@/components/shell/page-header';
import { DeleteUserDialog } from '@/components/admin/delete-user-dialog';

export const dynamic = 'force-dynamic';

const PER_PAGE = 50;

/**
 * Pagination is required, not decorative: the database holds thousands of
 * users (2,863 at the time of writing, nearly all of them e2e accounts), and
 * rendering them all would be a multi-megabyte response.
 *
 * `page` is clamped at both ends. A hand-typed `?page=0` or `?page=99999` is
 * not an error worth a 404 -- it is a URL someone edited -- so it resolves to
 * the first or last page instead of an empty table that looks like data loss.
 */
export default async function AdminUsersPage({
  searchParams,
}: {
  // Next 16: searchParams is a Promise. Do NOT import PageProps -- it is ambient.
  searchParams: Promise<{ page?: string }>;
}) {
  const total = await adminCountUsers();
  const lastPage = Math.max(1, Math.ceil(total / PER_PAGE));

  const raw = Number.parseInt((await searchParams).page ?? '1', 10);
  const page = Number.isFinite(raw) ? Math.min(Math.max(raw, 1), lastPage) : 1;

  const rows = await adminListUsers({
    limit: PER_PAGE,
    offset: (page - 1) * PER_PAGE,
  });

  return (
    <>
      <PageHeader
        eyebrow="Admin"
        title="Users"
        subtitle={`${total} total · page ${page} of ${lastPage} · newest first`}
      />
      <div className="px-4 pb-10 sm:px-7">
        <div className="glass-card overflow-x-auto">
          {/* The card has always said overflow-x-auto, but w-full made that a
              promise it could not keep: 100% of a 390px viewport is a width
              the table always "fits", so it squeezed seven columns instead of
              scrolling and the Delete control ended up a few pixels wide at
              the far edge. The minimum is what turns the scroll on. 720px is
              these seven columns at honest widths -- a readable address, an
              org name, an unbroken ISO date, three counts no narrower than
              their own headers, and the action -- and it is only a floor: a
              long e2e address is one unbreakable token, so the table grows
              past it on its own. */}
          <table className="w-full min-w-[720px] text-[13px]">
            <thead>
              <tr style={{ color: 'var(--muted)' }}>
                <th className="px-4 py-3 text-left font-semibold">Email</th>
                <th className="px-4 py-3 text-left font-semibold">Organization</th>
                <th className="px-4 py-3 text-left font-semibold">Joined</th>
                <th className="px-4 py-3 text-right font-semibold">Games</th>
                <th className="px-4 py-3 text-right font-semibold">Disks</th>
                <th className="px-4 py-3 text-right font-semibold">Devices</th>
                <th className="px-4 py-3 text-right font-semibold">Action</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr
                  key={r.userId}
                  data-testid="admin-user-row"
                  // The plan asked for BOTH "admin-user-row" and
                  // "user-row-<email>" on the row itself, which one element
                  // cannot have -- data-testid is a single attribute. Split
                  // instead: the row keeps the countable testid plus a
                  // data-email hook, and the email cell below carries the
                  // per-email testid. Task 5 can target a specific row with
                  // either [data-testid="admin-user-row"][data-email="..."]
                  // or getByTestId("admin-user-row").filter({ has: ... }).
                  data-email={r.email}
                  className="border-t"
                  style={{ borderColor: 'rgb(0 0 0 / 0.06)' }}
                >
                  <td className="px-4 py-3 font-mono text-[12px]" data-testid={`user-row-${r.email}`}>
                    {r.email}
                  </td>
                  <td className="px-4 py-3">
                    {/* Null when the organization bootstrap failed. Say so
                        rather than rendering an empty cell -- this list is
                        exactly where such an account should be visible. */}
                    {r.orgName ?? (
                      <span style={{ color: 'var(--amber-text)' }}>no organization</span>
                    )}
                  </td>
                  <td className="px-4 py-3 font-mono text-[12px]" style={{ color: 'var(--muted)' }}>
                    {r.createdAt.toISOString().slice(0, 10)}
                  </td>
                  <td className="px-4 py-3 text-right tabular-nums">{r.games}</td>
                  <td className="px-4 py-3 text-right tabular-nums">{r.disks}</td>
                  <td className="px-4 py-3 text-right tabular-nums">{r.devices}</td>
                  <td className="px-4 py-3 text-right">
                    <DeleteUserDialog
                      userId={r.userId}
                      email={r.email}
                      games={r.games}
                      disks={r.disks}
                      devices={r.devices}
                      orgName={r.orgName}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="mt-4 flex items-center gap-3 text-[13px]">
          <PageLink page={page - 1} disabled={page <= 1} label="Previous" />
          <PageLink page={page + 1} disabled={page >= lastPage} label="Next" />
        </div>
      </div>
    </>
  );
}

function PageLink({ page, disabled, label }: { page: number; disabled: boolean; label: string }) {
  if (disabled) {
    return (
      <span className="opacity-40" style={{ color: 'var(--on-dark-muted)' }} aria-disabled="true">
        {label}
      </span>
    );
  }
  return (
    <Link
      href={`/admin/users?page=${page}`}
      className="font-medium"
      style={{ color: 'rgb(233 240 244 / 0.85)' }}
    >
      {label}
    </Link>
  );
}
