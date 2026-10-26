'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { requestWriteProtect } from '@/components/devices/device-actions';

export function WriteProtectToggle({ diskId, writeProtected }: {
  diskId: string; writeProtected: boolean;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  async function onToggle() {
    setBusy(true);
    try {
      if (await requestWriteProtect(diskId, !writeProtected)) router.refresh();
    } finally {
      setBusy(false);
    }
  }

  return (
    <button type="button" onClick={onToggle} disabled={busy}
            data-testid={`wp-${diskId}`} data-protected={writeProtected ? 'true' : 'false'}
            aria-pressed={writeProtected}
            title={writeProtected
              ? 'Write protected — the device will refuse writes'
              : 'Writable — the Amiga can save to this disk; each save becomes a new version'}
            className="flex h-[38px] items-center gap-2.5 rounded-[10px] px-3 text-[13px] font-medium disabled:opacity-50 max-sm:min-h-11"
            style={{ color: 'var(--ink)' }}>
      <WpSwitch on={writeProtected} />
      {writeProtected ? 'Protected' : 'Writable'}
    </button>
  );
}

/** The board's switch: a 32x18 track (ink when protected, line-strong when writable) with a 14px knob. Decorative. */
export function WpSwitch({ on, small = false }: { on: boolean; small?: boolean }) {
  // `small`: the header drive panel's 28 x 16 switch (C8 spec §3.3); 32 x 18 everywhere else.
  return (
    <span aria-hidden="true" className={`flex shrink-0 box-border p-0.5 ${small ? 'h-4 w-7' : 'h-[18px] w-8'}`}
          style={{ justifyContent: on ? 'flex-end' : 'flex-start', background: on ? 'var(--ink)' : 'var(--line-strong)',
                   borderRadius: 999 }}>
      <span className={`${small ? 'size-3' : 'size-3.5'} rounded-full`} style={{ background: '#FFFDF8', boxShadow: '0 1px 2px rgba(0,0,0,0.25)' }} />
    </span>
  );
}
