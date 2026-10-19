'use client';
import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import type { DeviceListItem } from '@/lib/queries';
import { bootDiskNote, BOOT_DISK_FW, type BootDisk } from '@/lib/boot-disk';
import { HelpTip } from '@/components/help/help-tip';

/** Disk at startup (src/lib/boot-disk.ts): Last disk (default) | No disk. Applied by the server at the board's next
 *  power-up; nothing is sent to the board, so there is no "waiting for the board" state to show. */
export function BootDiskSetting({ device }: { device: DeviceListItem }) {
  const id = device.id;
  const router = useRouter();
  const [refreshing, startRefresh] = useTransition();
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  const note = bootDiskNote(device.bootDiskCapable);

  async function save(mode: BootDisk) {
    setBusy(true);
    setFailed(null);
    try {
      const res = await fetch(`/api/devices/${id}/boot-disk`, {
        method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ mode }),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => null) as { reason?: string } | null;
        setFailed(j?.reason ?? `Could not save (HTTP ${res.status})`);
        return;
      }
      startRefresh(() => router.refresh());
    } catch {
      setFailed('Could not reach the server');
    } finally { setBusy(false); }
  }

  return (
    <div className="flex flex-col gap-1 text-[11px]" style={{ color: 'var(--muted)' }}>
      <label className="flex flex-wrap items-center gap-x-2 gap-y-1">
        Disk at startup
        <select data-testid={`boot-disk-${id}`} value={device.bootDisk}
                disabled={busy || refreshing || (!device.bootDiskCapable && device.bootDisk === 'last')}
                onChange={(e) => save(e.target.value as BootDisk)}
                className="w-40 min-w-0 max-w-full rounded border px-1 py-0.5" style={{ borderColor: 'var(--hairline)', color: 'var(--ink)' }}>
          <option value="last">Last disk (default)</option>
          <option value="empty" disabled={!device.bootDiskCapable}>
            {device.bootDiskCapable ? 'No disk' : `No disk — needs firmware ${BOOT_DISK_FW}`}
          </option>
        </select>
        <HelpTip topic="boards" />
      </label>
      {note && <span data-testid={`boot-disk-note-${id}`}>{note}</span>}
      {failed && (
        <span role="alert" style={{ color: 'var(--amber-text)', overflowWrap: 'anywhere' }}
              data-testid={`boot-disk-error-${id}`}>{failed}</span>
      )}
    </div>
  );
}
