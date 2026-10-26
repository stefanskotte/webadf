'use client';

import { createContext, useContext, useState } from 'react';
import { CopyInviteButtons } from '@/components/admin/copy-invite-buttons';

type InviteIssue = { code: string | null; setCode: (code: string) => void };

/** The issued code, only while the server's list still has it live (revoked, used or expired elsewhere: gone). */
export function shownInviteCode(code: string | null, liveCodes: readonly string[]): string | null {
  return code !== null && liveCodes.includes(code) ? code : null;
}
const InviteIssueContext = createContext<InviteIssue | null>(null);

/**
 * The just-issued code, shared by the header's Issue an invite button and the panel under the tabs (C6 spec §4.1,
 * Ruling 18). Client state survives router.refresh(), so the code stays until the next issue or a reload.
 */
export function InviteIssueProvider({ liveCodes, children }: { liveCodes: readonly string[]; children: React.ReactNode }) {
  const [issued, setCode] = useState<string | null>(null);
  // Issue sets the code inside the same transition as the refresh, so the code and the list that holds it land together.
  const code = shownInviteCode(issued, liveCodes);
  return <InviteIssueContext.Provider value={{ code, setCode }}>{children}</InviteIssueContext.Provider>;
}

export function useInviteIssue(): InviteIssue {
  const ctx = useContext(InviteIssueContext);
  if (!ctx) throw new Error('useInviteIssue outside InviteIssueProvider');
  return ctx;
}

/**
 * The status panel after an issue (C6 spec §4.2). The sr-only live region exists from the first paint so the code
 * is announced when it arrives (Plan ruling, Task 4); sr-only is absolute, so it takes no place in the column.
 */
export function NewInvitePanel() {
  const { code } = useInviteIssue();
  return (
    <>
      <span role="status" className="sr-only">
        {code ? `New invite code ${code}, single use, expires in 7 days` : ''}
      </span>
      {code && (
        <div data-testid="new-invite-panel" className="flex flex-wrap items-center gap-4 rounded-[14px] px-[18px] py-4"
             style={{ background: 'var(--surface)', boxShadow: '0 0 0 1px var(--mounted-line)' }}>
          <span aria-hidden className="size-2 shrink-0 rounded-full" style={{ background: 'var(--online-dot)' }} />
          <div className="flex flex-col gap-0.5">
            <span className="text-[13px]" style={{ color: 'var(--muted)' }}>New code · single use · expires in 7 days</span>
            <span data-testid="new-invite-code" className="font-mono text-[22px] font-semibold tracking-[0.12em]"
                  style={{ color: 'var(--ink)' }}>{code}</span>
          </div>
          <span className="flex-1" />
          <CopyInviteButtons code={code} idPrefix="new-invite-copy" look="button" linkLabel="Copy sign-up link" />
        </div>
      )}
    </>
  );
}
