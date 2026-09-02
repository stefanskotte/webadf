import { notFound } from 'next/navigation';
import { Link } from '@/components/shell/link';
import { requireOrg } from '@/lib/session';
import { getGameDetail, listDevices } from '@/lib/queries';
import { deviceState } from '@/lib/device-state';
import { PageHeader } from '@/components/shell/page-header';
import { LiveRefresh } from '@/components/devices/live-refresh';
import { DiskRow, type DiskHolder } from '@/components/games/disk-row';
import { GameFacts } from '@/components/games/game-facts';

export default async function GamePage(props: PageProps<'/games/[id]'>) {
  const { orgId } = await requireOrg();
  const { id } = await props.params;

  const [game, devices] = await Promise.all([getGameDetail(orgId, id), listDevices(orgId)]);
  // Null covers "does not exist" and "belongs to another organization"
  // indistinguishably, so an id from another tenant reveals nothing.
  if (!game) notFound();

  const now = Date.now();

  // Which device, if any, is doing something with each disk. Keyed by sha256
  // because that is what both halves of the device row carry.
  //
  // Known limitation: `!holders.has(sha)` keeps only the FIRST device found
  // for a given sha256, and `listDevices` orders by name -- so if two
  // devices hold or are mounting the same disk content, only the
  // alphabetically-first device's name is shown here, with nothing telling
  // the reader a second device also has it. Plausible with several units and
  // identical content. Not fixed here -- surfacing multiple holders is a
  // display change out of this task's scope, not a one-line fix.
  const holders = new Map<string, DiskHolder>();
  for (const d of devices) {
    const state = deviceState(d, now);
    if (state === 'empty') continue;
    const sha = state === 'converged' ? d.mountedSha256 : d.desiredSha256;
    if (sha && !holders.has(sha)) {
      holders.set(sha, { deviceName: d.name, state });
    }
  }

  const anyPending = devices.some((d) => {
    const s = deviceState(d, now);
    return s === 'pending' || s === 'stale';
  });

  const targets = devices.map((d) => ({ id: d.id, name: d.name }));

  return (
    <>
      <PageHeader
        eyebrow="Library / Games"
        title={game.title}
        subtitle={[game.year, game.publisher, game.genre, game.chipset,
                   `${game.disks.length} disk${game.disks.length === 1 ? '' : 's'}`]
                  .filter(Boolean).join(' · ')}
        actions={
          <Link href="/library" className="text-[12.5px] font-semibold"
                style={{ color: 'var(--on-dark-muted)' }}>← Library</Link>
        }
      />
      <LiveRefresh active={anyPending} />
      <GameFacts game={game} />
      <div className="flex flex-col gap-3 px-4 pb-10 sm:px-7">
        {game.disks.map((disk) => (
          <DiskRow key={disk.id} disk={disk} devices={targets}
                   holder={holders.get(disk.sha256) ?? null} />
        ))}
      </div>
    </>
  );
}
