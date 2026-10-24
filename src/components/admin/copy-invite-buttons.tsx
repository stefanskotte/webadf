'use client';

import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { inviteSignUpUrl } from '@/lib/invite-link';

type Which = 'code' | 'link';

/** Copy code / Copy link for one invite. The link uses window.location.origin so a self-hosted instance copies its own address. */
export function CopyInviteButtons({ code }: { code: string }) {
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

  const cls = 'text-[12.5px] font-semibold';
  return (
    <span className="inline-flex items-center gap-3">
      <button type="button" onClick={() => copy('code')} data-testid={`invite-copy-code-${code}`} className={cls}>
        {copied === 'code' ? 'Copied' : 'Copy code'}
      </button>
      <button type="button" onClick={() => copy('link')} data-testid={`invite-copy-link-${code}`} className={cls}>
        {copied === 'link' ? 'Copied' : 'Copy link'}
      </button>
    </span>
  );
}
