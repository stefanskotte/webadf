import { adminListInvites } from '@/lib/admin-queries';
import { PageHeader } from '@/components/shell/page-header';
import { IssueInviteButton } from '@/components/admin/issue-invite-button';
import { RevokeInviteButton } from '@/components/admin/revoke-invite-button';

export const dynamic = 'force-dynamic';

// Live first, then newest first -- adminListInvites orders it that way in SQL
// so this page never recomputes the state from three columns and disagrees
// with the query about which codes are actually usable.
const STATE_STYLE: Record<string, { label: string; color: string }> = {
  live: { label: 'Live', color: 'var(--amber-text)' },
  consumed: { label: 'Used', color: 'var(--muted)' },
  expired: { label: 'Expired', color: 'var(--muted)' },
};

export default async function AdminInvitesPage() {
  const invites = await adminListInvites();
  const live = invites.filter((i) => i.state === 'live').length;

  return (
    <>
      <PageHeader
        eyebrow="Admin"
        title="Invites"
        subtitle={`${live} live · ${invites.length} total · registration is invite-only (D13)`}
        actions={<IssueInviteButton />}
      />
      <div className="px-7 pb-10">
        {live === 0 && (
          <div
            className="glass-card mb-3 p-4 text-[13px]"
            style={{ color: 'var(--muted)' }}
          >
            No live invite codes. <strong>Nobody can register</strong> until one is
            issued — registration is closed behind these codes by design.
          </div>
        )}
        <div className="glass-card overflow-x-auto">
          <table className="w-full text-[13px]">
            <thead>
              <tr style={{ color: 'var(--muted)' }}>
                <th className="px-4 py-3 text-left font-semibold">Code</th>
                <th className="px-4 py-3 text-left font-semibold">State</th>
                <th className="px-4 py-3 text-left font-semibold">Issued</th>
                <th className="px-4 py-3 text-left font-semibold">Expires</th>
                <th className="px-4 py-3 text-right font-semibold">Action</th>
              </tr>
            </thead>
            <tbody>
              {invites.map((i) => {
                const style = STATE_STYLE[i.state];
                return (
                  <tr
                    key={i.code}
                    data-testid={`invite-${i.code}`}
                    className="border-t"
                    style={{ borderColor: 'rgb(0 0 0 / 0.06)' }}
                  >
                    <td className="px-4 py-3 font-mono text-[12.5px] font-semibold">{i.code}</td>
                    <td className="px-4 py-3 font-semibold" style={{ color: style.color }}>
                      {style.label}
                    </td>
                    <td className="px-4 py-3 font-mono text-[12px]" style={{ color: 'var(--muted)' }}>
                      {i.createdAt.toISOString().slice(0, 10)}
                    </td>
                    <td className="px-4 py-3 font-mono text-[12px]" style={{ color: 'var(--muted)' }}>
                      {i.expiresAt.toISOString().slice(0, 10)}
                    </td>
                    <td className="px-4 py-3 text-right">
                      {/* Only a live code is revocable. A consumed one is the
                          record that an account exists; an expired one is
                          already dead as a credential. */}
                      {i.state === 'live' ? <RevokeInviteButton code={i.code} /> : null}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </>
  );
}
