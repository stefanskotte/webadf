import type { DeviceListItem } from '@/lib/queries';
import { driverDiskLine, driverLine, amigaAddressLine, trafficText, type Line } from '@/lib/network-checklist';

/** Network mode's checklist (spec 2026-10-12 §5), shown while the board runs Network mode. */
export function NetworkChecklist({ device, now }: { device: DeviceListItem; now: number }) {
  const id = device.id;
  const lines: [string, Line][] = [
    ['net-disk', driverDiskLine(device)],
    ['net-driver', driverLine(device.netDriverSeenAt, now)],
    ['net-ip', amigaAddressLine(device.netAmigaIp)],
  ];
  const traffic = trafficText(device.netFramesIn, device.netFramesOut);
  return (
    <span className="flex flex-col text-[11px]" style={{ color: 'var(--muted)' }} data-testid={`net-checklist-${id}`}>
      {lines.map(([key, l]) => (
        <span key={key} data-testid={`${key}-${id}`} data-ok={String(l.ok)}
              style={{ color: l.ok ? 'var(--ink)' : 'var(--amber-text)' }}>
          {l.ok ? '✓ ' : '• '}{l.text}
        </span>
      ))}
      {traffic && <span data-testid={`net-traffic-${id}`}>{traffic}</span>}
    </span>
  );
}
