import { adminListUsers, adminCountUsers } from '@/lib/admin-queries';
import { isSuperAdminEmail } from '@/lib/superadmin';
import { AdminPageHead, ADMIN_BODY } from '@/components/admin/admin-page-head';
import { DeleteUserDialog } from '@/components/admin/delete-user-dialog';
import { PagerLink } from '@/components/admin/pager-link';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Admin · Users' };

const PER_PAGE = 50;
// Below sm each row stacks (see the table's comment); a number then reads "Titles 3" from its data-label.
const LABEL = 'max-sm:before:mr-1.5 max-sm:before:font-sans max-sm:before:text-[12px] max-sm:before:text-(--muted-2) max-sm:before:content-[attr(data-label)]';
const NUM = `px-3.5 py-3 text-right font-mono tabular-nums max-sm:p-0 ${LABEL}`;

/**
 * Pagination is required, not decorative: the database holds thousands of users (nearly all of them e2e accounts),
 * and rendering them all would be a multi-megabyte response.
 *
 * `page` is clamped at both ends. A hand-typed `?page=0` or `?page=99999` is not an error worth a 404 -- it is a URL
 * someone edited -- so it resolves to the first or last page instead of an empty table that looks like data loss.
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

  const rows = await adminListUsers({ limit: PER_PAGE, offset: (page - 1) * PER_PAGE });

  return (
    <>
      <AdminPageHead title="Users" subtitle={`${total} users · newest first · page ${page} of ${lastPage}`} />
      <div className={ADMIN_BODY}>
        {/* Still a real table (Ruling 8): header association, and getByRole('row') semantics. It scrolls sideways
            inside the card from sm up; the page does not. 760px is the seven columns at honest widths, and only a
            floor: a long e2e address is one unbreakable token unless it wraps, which it does. Below sm (390 px) the
            rows stack instead -- email, organization, then the figures with Delete… at the end of the line -- so the
            action never sits past a sideways scroll. The roles are explicit because display:block drops a table's
            semantics in some browsers; the header row stays for them and is visually hidden there. */}
        <section aria-label="Users" className="overflow-hidden rounded-[16px]"
                 style={{ background: 'var(--surface)', boxShadow: '0 0 0 1px var(--line)' }}>
          <div className="overflow-x-auto">
            <table role="table" className="w-full text-[14px] max-sm:block sm:min-w-[760px]" style={{ color: 'var(--ink)' }}>
              <thead role="rowgroup" className="max-sm:sr-only">
                <tr role="row" className="h-11 border-b text-[12px] max-sm:block" style={{ borderColor: 'var(--line)', color: 'var(--muted-2)' }}>
                  <th role="columnheader" scope="col" className="px-5 text-left font-medium">Email</th>
                  <th role="columnheader" scope="col" className="px-3.5 text-left font-medium">Organization</th>
                  <th role="columnheader" scope="col" className="w-[120px] px-3.5 text-left font-medium">Joined</th>
                  <th role="columnheader" scope="col" className="w-[70px] px-3.5 text-right font-medium">Titles</th>
                  <th role="columnheader" scope="col" className="w-[70px] px-3.5 text-right font-medium">Disks</th>
                  <th role="columnheader" scope="col" className="w-20 px-3.5 text-right font-medium">Boards</th>
                  <th role="columnheader" scope="col" className="w-[150px] px-3.5 text-right font-medium">Action</th>
                </tr>
              </thead>
              <tbody role="rowgroup" className="max-sm:block">
                {rows.map((r) => {
                  // Server-side, on a page only admins see (Ruling 10): the allowlist never reaches a non-admin.
                  const isAdmin = isSuperAdminEmail(r.email);
                  return (
                    // The row keeps the countable testid plus a data-email hook; the email cell carries the per-email
                    // testid (one element cannot have both).
                    <tr key={r.userId} role="row" data-testid="admin-user-row" data-email={r.email}
                        className="border-b hover:bg-(--surface-2) max-sm:flex max-sm:flex-wrap max-sm:items-center max-sm:gap-x-4 max-sm:gap-y-1 max-sm:px-5 max-sm:py-3" style={{ borderColor: 'var(--hairline)' }}>
                      <td role="cell" className="px-5 py-3 max-sm:basis-full max-sm:p-0" data-testid={`user-row-${r.email}`}>
                        <span className="flex flex-wrap items-center gap-2">
                          <span className="[overflow-wrap:anywhere]">{r.email}</span>
                          {isAdmin && (
                            <span data-admin-pill className="rounded-full px-[7px] py-px text-[11px] font-semibold"
                                  style={{ background: 'var(--ink)', color: 'var(--surface)' }}>
                              Admin
                            </span>
                          )}
                        </span>
                      </td>
                      <td role="cell" className="px-3.5 py-3 [overflow-wrap:anywhere] max-sm:basis-full max-sm:p-0" style={{ color: 'var(--muted)' }}>
                        {/* Null when the organization bootstrap failed. Say so rather than rendering an empty cell --
                            this list is exactly where such an account should be visible. */}
                        {r.orgName ?? <span style={{ color: 'var(--amber-text)' }}>no organization</span>}
                      </td>
                      <td role="cell" data-label="Joined" className={`px-3.5 py-3 font-mono text-[13px] max-sm:p-0 ${LABEL}`} style={{ color: 'var(--muted)' }}>
                        {r.createdAt.toISOString().slice(0, 10)}
                      </td>
                      <td role="cell" data-label="Titles" className={NUM}>{r.games}</td>
                      <td role="cell" data-label="Disks" className={NUM}>{r.disks}</td>
                      <td role="cell" data-label="Boards" className={NUM}>{r.devices}</td>
                      <td role="cell" className="px-3.5 py-3 text-right max-sm:ml-auto max-sm:p-0">
                        <DeleteUserDialog userId={r.userId} email={r.email} games={r.games} disks={r.disks}
                                          devices={r.devices} orgName={r.orgName} isAdmin={isAdmin} />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <div className="flex min-h-[52px] flex-wrap items-center justify-between gap-3 border-t px-5 py-2.5 text-[13px]"
               style={{ borderColor: 'var(--hairline)', color: 'var(--muted-2)' }}>
            {/* Ruling 11: the dialog's own facts. Shared images are kept for good; unreferenced ones go weekly. */}
            <p data-users-foot>
              Deleting a user removes their organization, titles, disks and boards. Disk images are kept: other
              libraries may share them.
            </p>
            <div className="flex gap-1.5">
              <PagerLink href={page > 1 ? `/admin/users?page=${page - 1}` : null} label="Previous" />
              <PagerLink href={page < lastPage ? `/admin/users?page=${page + 1}` : null} label="Next" />
            </div>
          </div>
        </section>
      </div>
    </>
  );
}
