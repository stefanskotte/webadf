import { requireOrg } from '@/lib/session';
import { listDevices } from '@/lib/queries';
import { deviceState, STALE_AFTER_MS } from '@/lib/device-state';
import { PageHeader } from '@/components/shell/page-header';
import { DeviceCard } from '@/components/devices/device-card';
import { PairButton } from '@/components/devices/pair-button';
import { LiveRefresh } from '@/components/devices/live-refresh';

export default async function DevicesPage() {
  const { orgId } = await requireOrg();
  const devices = await listDevices(orgId);

  // One clock for the whole render, so two cards can never disagree about what
  // "now" is and flip each other across the staleness boundary.
  const now = Date.now();

  const online = devices.filter(
    (d) => d.lastSeenAt && now - d.lastSeenAt.getTime() <= STALE_AFTER_MS,
  ).length;
  const anyPending = devices.some((d) => {
    const s = deviceState(d, now);
    return s === 'pending' || s === 'stale';
  });

  return (
    <>
      <PageHeader
        eyebrow="Hardware"
        title="Devices"
        subtitle={`${devices.length} paired · ${online} online · long-poll every 25 s`}
        actions={<PairButton />}
      />
      <LiveRefresh active={anyPending} />
      <div className="flex flex-col gap-3 px-4 pb-10 sm:px-7">
        {devices.length === 0 ? (
          <div className="glass-card p-6 text-[13px]" style={{ color: 'var(--muted)' }}>
            No devices paired yet. Press <strong>Pair a device</strong> and enter the code on the hardware.
          </div>
        ) : (
          devices.map((d) => <DeviceCard key={d.id} device={d} now={now} />)
        )}
      </div>
    </>
  );
}
