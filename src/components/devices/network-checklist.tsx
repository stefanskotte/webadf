import type { DeviceListItem } from '@/lib/queries';
import { DriverLine } from '@/components/devices/driver-line';
import { CheckRow } from '@/components/devices/check-row';
import { HelpTip } from '@/components/help/help-tip';
import { driverDiskLine, amigaAddressLine, trafficText } from '@/lib/network-checklist';

/** Network mode's checklist (spec 2026-10-12 §5; Devices spec §6): a list of rows, each with a round mark and its
 *  state in words, then the `network` help tip. Shown while the board runs Network mode. */
export function NetworkChecklist({ device, now }: { device: DeviceListItem; now: number }) {
  const id = device.id;
  const traffic = trafficText(device.netFramesIn, device.netFramesOut);
  return (
    <div className="flex min-w-0 items-start gap-1">
      <ul aria-label="Amiga network" data-testid={`net-checklist-${id}`} className="m-0 flex min-w-0 list-none flex-col gap-2 p-0">
        <CheckRow testid={`net-disk-${id}`} l={driverDiskLine(device)} />
        <DriverLine id={id} seenAtMs={device.netDriverSeenAt?.getTime() ?? null} serverNow={now} />
        <CheckRow testid={`net-ip-${id}`} l={amigaAddressLine(device.netAmigaIp)} />
        {traffic && (
          <li data-testid={`net-traffic-${id}`} className="text-[12px]" style={{ color: 'var(--muted-2)' }}>{traffic}</li>
        )}
      </ul>
      <HelpTip topic="network" className="-mt-1" />
    </div>
  );
}
