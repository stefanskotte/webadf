'use client';

import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { inviteSignUpUrl } from '@/lib/invite-link';

type Which = 'code' | 'link';

/**
 * Copy code / Copy link for one invite. The link uses window.location.origin so a self-hosted instance copies its
 * own address. `look`: `row` (the table's 30 px transparent pair) or `button` (the new-code panel's 38 px outline
 * pair, C6 spec §4.2); `linkLabel` names the link button (the panel says `Copy sign-up link`, Ruling 18).
 */
export function CopyInviteButtons({ code, idPrefix, look = 'row', linkLabel = 'Copy link' }: {
  code: string; idPrefix?: string; look?: 'row' | 'button'; linkLabel?: string;
}) {
  // Table rows use invite-copy-<which>-<code>. A surface that can sit beside a row for the same code (the new-code
  // panel) passes idPrefix, giving <idPrefix>-<which> with no code, so the two never share a test id.
  const tid = (which: Which) => (idPrefix ? `${idPrefix}-${which}` : `invite-copy-${which}-${code}`);
  const [copied, setCopied] = useState<Which | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  async function copy(which: Which) {
    const text = which === 'code' ? code : inviteSignUpUrl(window.location.origin, code);
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      toast.error('Could not copy', { description: 'The browser refused clipboard access.' });
      return;
    }
    setCopied(which);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopied(null), 2000);
  }

  const cls = look === 'button'
    ? 'h-[38px] rounded-[10px] border border-(--line) bg-(--surface) px-3.5 text-[13px] font-medium text-(--ink) hover:bg-(--track) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--ring)'
    : 'h-[30px] rounded-[8px] px-2.5 text-[13px] font-medium text-(--ink) hover:bg-(--track) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--ring)';
  return (
    <span className={look === 'button' ? 'inline-flex flex-wrap items-center gap-2' : 'inline-flex items-center gap-1'}>
      <button type="button" onClick={() => copy('code')} data-testid={tid('code')} className={cls}>
        {copied === 'code' ? 'Copied' : 'Copy code'}
      </button>
      <button type="button" onClick={() => copy('link')} data-testid={tid('link')} className={cls}>
        {copied === 'link' ? 'Copied' : linkLabel}
      </button>
    </span>
  );
}
