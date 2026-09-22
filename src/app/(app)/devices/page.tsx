import { requireOrg } from '@/lib/session';
import { listDevices } from '@/lib/queries';
import { listReleases } from '@/lib/firmware-releases';
import { firmwareState, countBehind, buildRegistry } from '@/lib/firmware-state';
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

  // The registry is indexed ONCE and shared, so "which release is newest" is
  // computed in exactly one place -- the notice and the cards cannot disagree
  // about it, and the per-device step is a map lookup rather than three walks
  // of the whole release list.
  const registry = buildRegistry(releases);
  const states = devices.map((d) => firmwareState(d.firmwareVersion, registry));
  const behind = countBehind(states);
  // True when any release a BEHIND device is missing is a security release --
  // not merely when the newest one is. A security release followed by an
  // ordinary one must not go quiet for the boards still missing the fix.
  const securityPending = states.some((s) => s.kind === 'behind' && s.securityPending);

  return (
    <>
      <PageHeader
        eyebrow="Hardware"
        title="Devices"
        subtitle={`${devices.length} paired · ${online} online · long-poll every 25 s`}
        actions={<PairButton />}
      />
      <div className="flex flex-col gap-3 px-4 pb-10 sm:px-7">
        {registry.latest && (
          <FirmwareNotice behind={behind} total={devices.length}
                          latest={registry.latest} security={securityPending} />
        )}
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
