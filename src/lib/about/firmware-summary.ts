import { listReleases } from '@/lib/firmware-releases';
import { listDevices } from '@/lib/queries';
import { buildRegistry, firmwareState, countBehind, type ReleaseRef } from '@/lib/firmware-state';

/**
 * The newest release this org may install and how many of its boards are
 * behind it -- the SAME registry the Devices page builds, so the two pages
 * cannot disagree (TEST builds only for FIRMWARE_BENCH_ORGS, via listReleases).
 */
export async function firmwareSummary(orgId: string): Promise<{ latest: ReleaseRef | null; boards: number; behind: number }> {
  const [releases, devices] = await Promise.all([listReleases(orgId), listDevices(orgId)]);
  const registry = buildRegistry(releases);
  const states = devices.map((d) => firmwareState(d.firmwareVersion, registry));
  return { latest: registry.latest, boards: devices.length, behind: countBehind(states) };
}
