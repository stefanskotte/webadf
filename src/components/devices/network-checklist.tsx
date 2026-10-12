import type { DeviceListItem } from '@/lib/queries';
import { DriverLine } from '@/components/devices/driver-line';
import { driverDiskLine, amigaAddressLine, trafficText, type Line } from '@/lib/network-checklist';

function Row({ testid, l }: { testid: string; l: Line }) {
  return (
    <span data-testid={testid} data-ok={String(l.ok)} style={{ color: l.ok ? 'var(--ink)' : 'var(--amber-text)' }}>
      {l.ok ? '✓ ' : '• '}{l.text}
    </span>
  );
}

/** Network mode's checklist (spec 2026-10-12 §5), shown while the board runs Network mode. */
export function NetworkChecklist({ device, now }: { device: DeviceListItem; now: number }) {
  const id = device.id;
  const traffic = trafficText(device.netFramesIn, device.netFramesOut);
  return (
    <span className="flex flex-col text-[11px]" style={{ color: 'var(--muted)' }} data-testid={`net-checklist-${id}`}>
      <Row testid={`net-disk-${id}`} l={driverDiskLine(device)} />
      <DriverLine id={id} seenAtMs={device.netDriverSeenAt?.getTime() ?? null} serverNow={now} />
      <Row testid={`net-ip-${id}`} l={amigaAddressLine(device.netAmigaIp)} />
      {traffic && <span data-testid={`net-traffic-${id}`}>{traffic}</span>}
    </span>
  );
}
