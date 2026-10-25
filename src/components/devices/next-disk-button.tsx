'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import type { NextInfo } from '@/lib/next-disk';
import { requestNextDisk } from './device-actions';
import { BOX_BTN, BOX_BTN_STYLE } from './box-button';

export function NextDiskButton({ deviceId, next }: { deviceId: string; next: NextInfo }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [busy, setBusy] = useState(false);

  async function onClick() {
    setBusy(true);
    try {
      if (await requestNextDisk(deviceId)) start(() => router.refresh());
    } finally {
      setBusy(false);
    }
  }

  return (
    <button type="button" onClick={onClick} disabled={busy || pending}
            data-testid={`next-disk-${deviceId}`}
            className={BOX_BTN} style={BOX_BTN_STYLE}>
      {busy || pending ? 'Switching…' : `Next: disk ${next.diskNo}`}
    </button>
  );
}
