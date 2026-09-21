import { requireOrg } from '@/lib/session';
import { listDevices } from '@/lib/queries';
import { listReleases } from '@/lib/firmware-releases';
import { firmwareState, countBehind } from '@/lib/firmware-state';
import { isOnline } from '@/lib/device-state';
import { PageHeader } from '@/components/shell/page-header';
import { DeviceCard } from '@/components/devices/device-card';
import { PairButton } from '@/components/devices/pair-button';
import { FirmwareNotice } from '@/components/devices/firmware-notice';

export default async function DevicesPage() {
  const { orgId } = await requireOrg();
  // Independent reads, so they go together rather than in series.
  const [devices, releases] = await Promise.all([listDevices(orgId), listReleases()]);

  // One clock for the whole render, so two cards can never disagree about what
  // "now" is and flip each other across the staleness boundary.
  const now = Date.now();

  const online = devices.filter((d) => isOnline(d.lastSeenAt, now)).length;

  // One firmware verdict per device, computed once here so the notice and the
  // cards can never disagree about who is behind. listReleases orders by
  // sequence desc, so releases[0] is the newest; firmwareState does not rely
  // on that ordering, but the notice does.
  const states = devices.map((d) => firmwareState(d.firmwareVersion, releases));
  const behind = countBehind(states);
  const latest = releases[0];

  return (
    <>
      <PageHeader
        eyebrow="Hardware"
        title="Devices"
        subtitle={`${devices.length} paired · ${online} online · long-poll every 25 s`}
        actions={<PairButton />}
      />
      <div className="flex flex-col gap-3 px-4 pb-10 sm:px-7">
        {latest && <FirmwareNotice behind={behind} total={devices.length} latest={latest} />}
        {devices.length === 0 ? (
          <div className="glass-card p-6 text-[13px]" style={{ color: 'var(--muted)' }}>
            No devices paired yet. Press <strong>Pair a device</strong> and enter the code on the hardware.
          </div>
        ) : (
          devices.map((d, i) => <DeviceCard key={d.id} device={d} now={now} firmware={states[i]} />)
        )}
      </div>
    </>
  );
}
