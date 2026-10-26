import { adminListInvites, type InviteState } from '@/lib/admin-queries';
import { AdminPageHead, ADMIN_BODY } from '@/components/admin/admin-page-head';
import { IssueInviteButton } from '@/components/admin/issue-invite-button';
import { InviteIssueProvider, NewInvitePanel } from '@/components/admin/invite-issue';
import { CopyInviteButtons } from '@/components/admin/copy-invite-buttons';
import { RevokeInviteButton } from '@/components/admin/revoke-invite-button';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Admin · Invites' };

// Live first, then newest first -- adminListInvites orders it that way in SQL so this page never recomputes the
// state from three columns and disagrees with the query about which codes are actually usable. Sentence case;
// `Revoked` and `Used` are pinned (Ruling 19).
const STATE_LOOK: Record<InviteState, { label: string; bg: string; fg: string }> = {
  live: { label: 'Live', bg: 'var(--success-bg)', fg: 'var(--success-fg)' },
  consumed: { label: 'Used', bg: 'var(--track)', fg: 'var(--muted)' },
  expired: { label: 'Expired', bg: 'var(--surface-2)', fg: 'var(--muted-2)' },
  revoked: { label: 'Revoked', bg: 'var(--danger-bg)', fg: 'var(--danger-strong)' },
};
const TH = 'px-3.5 text-left font-medium';
const DATE = 'px-3.5 py-3 font-mono text-[13px] max-sm:basis-full max-sm:p-0';
// Below sm each row stacks like Users (C6 Ruling 8 amended; C7 Ruling 9): the code and its pill, then a labelled line
// each for Issued, Expires and Used by, then the actions in a wrapping row. Explicit roles keep it a table.
const LABEL = 'max-sm:before:mr-1.5 max-sm:before:font-sans max-sm:before:text-[12px] max-sm:before:text-(--muted-2) max-sm:before:content-[attr(data-label)]';

export default async function AdminInvitesPage() {
  const invites = await adminListInvites();
  const live = invites.filter((i) => i.state === 'live').length;

  return (
    <InviteIssueProvider liveCodes={invites.filter((i) => i.state === 'live').map((i) => i.code)}>
      <AdminPageHead title="Invites" subtitle={`${live} live · ${invites.length} total · invite-only`}
                     actions={<IssueInviteButton />} />
      <div className={ADMIN_BODY}>
        <NewInvitePanel />
        {live === 0 && (
          // The other value ("N live") is the subtitle's.
          <div role="note" data-testid="invites-none-live" className="flex items-center gap-3 rounded-[14px] px-[18px] py-4 text-[14px]"
               style={{ background: 'var(--warning-bg)', color: 'var(--warning-fg)' }}>
            <span aria-hidden className="size-2 shrink-0 rounded-full" style={{ background: 'var(--fetch-dot)' }} />
            <span>No live invite codes. Nobody can sign up until one is issued — registration is invite-only by design.</span>
          </div>
        )}
        <section aria-label="Invite codes" className="overflow-hidden rounded-[16px]"
                 style={{ background: 'var(--surface)', boxShadow: '0 0 0 1px var(--line)' }}>
          {/* From sm, 880px: an eight-character code, a state pill, two ISO dates that must never wrap mid-token, an email
              with its consumed date, and three actions. It scrolls inside the card; the page does not. Below sm the rows
              stack (see LABEL) and nothing scrolls sideways. */}
          <div className="overflow-x-auto">
            <table role="table" className="w-full text-[14px] max-sm:block sm:min-w-[880px]" style={{ color: 'var(--ink)' }}>
              <thead role="rowgroup" className="max-sm:sr-only">
                <tr role="row" className="h-11 border-b text-[12px]" style={{ borderColor: 'var(--line)', color: 'var(--muted-2)' }}>
                  <th role="columnheader" scope="col" className="px-5 text-left font-medium">Code</th>
                  <th role="columnheader" scope="col" className={`${TH} w-[120px]`}>State</th>
                  <th role="columnheader" scope="col" className={`${TH} w-[150px]`}>Issued</th>
                  <th role="columnheader" scope="col" className={`${TH} w-[150px]`}>Expires</th>
                  <th role="columnheader" scope="col" className={`${TH} w-[220px]`}>Used by</th>
                  <th role="columnheader" scope="col" className="w-[240px] px-3.5 text-right font-medium">Action</th>
                </tr>
              </thead>
              <tbody role="rowgroup" className="max-sm:block">
                {invites.length === 0 ? (
                  <tr role="row" data-testid="invites-empty" className="max-sm:block">
                    <td role="cell" colSpan={6} className="px-5 py-4 text-[13px] max-sm:block" style={{ color: 'var(--muted)' }}>
                      No invite codes yet. Issue one to let someone sign up.
                    </td>
                  </tr>
                ) : invites.map((i) => {
                  const look = STATE_LOOK[i.state];
                  return (
                    <tr key={i.code} role="row" data-testid={`invite-${i.code}`}
                        className="border-b max-sm:flex max-sm:flex-wrap max-sm:items-center max-sm:gap-x-3 max-sm:gap-y-1.5 max-sm:px-5 max-sm:py-3"
                        style={{ borderColor: 'var(--hairline)' }}>
                      <td role="cell" className="px-5 py-3 font-mono text-[15px] tracking-[0.1em] max-sm:p-0 max-sm:text-[16px]">{i.code}</td>
                      <td role="cell" className="px-3.5 py-3 max-sm:p-0">
                        <span data-state={i.state} className="rounded-full px-[9px] py-0.5 text-[12px] font-semibold"
                              style={{ background: look.bg, color: look.fg }}>
                          {look.label}
                        </span>
                      </td>
                      <td role="cell" data-label="Issued" className={`${DATE} ${LABEL}`} style={{ color: 'var(--muted)' }}>{i.createdAt.toISOString().slice(0, 10)}</td>
                      <td role="cell" data-label="Expires" className={`${DATE} ${LABEL}`} style={{ color: 'var(--muted)' }}>{i.expiresAt.toISOString().slice(0, 10)}</td>
                      <td role="cell" data-label="Used by" className={`px-3.5 py-3 max-sm:flex max-sm:basis-full max-sm:flex-wrap max-sm:items-baseline max-sm:p-0 ${LABEL}`}
                          data-testid={`invite-used-by-${i.code}`}>
                        {i.state === 'consumed' ? (
                          <div className="flex flex-col">
                            <span className="text-[14px] [overflow-wrap:anywhere]" style={{ color: 'var(--muted)' }}>{i.usedByEmail ?? '—'}</span>
                            {i.consumedAt && (
                              <span className="font-mono text-[12px]" style={{ color: 'var(--muted-2)' }}>
                                {i.consumedAt.toISOString().slice(0, 10)}
                              </span>
                            )}
                          </div>
                        ) : (
                          <span style={{ color: 'var(--muted-2)' }}>—</span>
                        )}
                      </td>
                      <td role="cell" className="px-3.5 py-3 max-sm:basis-full max-sm:p-0">
                        {/* Only a live code is revocable; a non-live row's state pill is the word. */}
                        {i.state === 'live' ? (
                          <span className="flex flex-wrap items-center justify-end gap-1 max-sm:justify-start max-sm:gap-2">
                            <CopyInviteButtons code={i.code} />
                            <RevokeInviteButton code={i.code} />
                          </span>
                        ) : null}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </section>
      </div>
    </InviteIssueProvider>
  );
}
