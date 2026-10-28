import { notFound } from 'next/navigation';
import { nowMs } from '@/lib/clock';
import { getDb } from '@/db';
import { requireOrg } from '@/lib/session';
import { listDevices } from '@/lib/queries';
import { mountChoices } from '@/lib/mount-choice';
import { listSendTargets } from '@/lib/send-targets';
import { fmtSize } from '@/lib/format';
import { ID_RE, remotePaths } from '@/lib/remote/http';
import { hiddenDiskId } from '@/lib/remote/materialise';
import { loadRemote, remoteLibrary } from '@/lib/remote/pages';
import { checkFiles, checkTitleDetail } from '@/lib/remote/wire';
import { remoteDiskHref, remoteTitleHref } from '@/lib/remote/view';
import { Breadcrumb, type Crumb } from '@/components/shell/breadcrumb';
import { RemoteMarker } from '@/components/remote/remote-marker';
import { RemoteProblem } from '@/components/remote/remote-problem';
import { RemoteFileTree } from '@/components/remote/remote-file-tree';
import { RemoteDiskActions } from '@/components/remote/remote-disk-actions';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/**
 * An owner disk's files (library sharing spec §4.5), read-only: the volume, its usage and the tree. `?title=` names
 * the title it was opened from, for the trail and the disk actions; without it the page still lists the files.
 */
export default async function RemoteDiskPage(props: PageProps<'/remote/[id]/disks/[diskId]'>) {
  const { orgId } = await requireOrg();
  const { id, diskId } = await props.params;
  if (!ID_RE.test(diskId)) notFound();
  const lib = await remoteLibrary(orgId, id);
  if (!lib) notFound();
  const sp = await props.searchParams;
  const titleId = typeof sp.title === 'string' && ID_RE.test(sp.title) ? sp.title : null;

  const ended = lib.status === 'ended';
  const [files, detail] = ended
    ? [{ ok: false as const, failure: 'ended' as const, detail: undefined }, null]
    : await Promise.all([
      loadRemote(orgId, id, remotePaths.files(diskId), checkFiles),
      titleId ? loadRemote(orgId, id, remotePaths.title(titleId), checkTitleDetail) : Promise.resolve(null),
    ]);
  const title = detail?.ok ? detail.value.title : null;
  const disk = detail?.ok ? detail.value.disks.find((d) => d.id === diskId) ?? null : null;

  const crumbs: Crumb[] = [{ label: 'Remote', href: '/remote' }, { label: lib.name, href: `/remote/${encodeURIComponent(id)}` }];
  if (title) crumbs.push({ label: title.title, href: remoteTitleHref(id, title.id) });
  crumbs.push({ label: disk ? `Disk ${disk.diskNo}` : 'Disk' });

  let actions: React.ReactNode = null;
  if (title && disk) {
    const [devices, sendTargets] = await Promise.all([listDevices(orgId), listSendTargets(getDb(), orgId)]);
    const now = nowMs();
    actions = (
      <RemoteDiskActions
        where={{ libraryId: id, titleId: title.id, diskId, host: lib.host }}
        choices={mountChoices(devices, { id: hiddenDiskId(orgId, id, diskId), sha256: disk.sha256, imageFormat: disk.imageFormat, sizeBytes: disk.sizeBytes }, now)}
        send={disk.imageFormat === 'adf' && sendTargets.length > 0 ? { targets: sendTargets, now } : null}
        filename={`${title.title} - Disk ${disk.diskNo}.${disk.imageFormat === 'hfe' ? 'hfe' : 'adf'}`}
        label={`${title.title}, disk ${disk.diskNo}`} />
    );
  }

  const v = files.ok && 'volume' in files.value ? files.value : null;
  const heading = v?.volume.name || disk?.name || 'Disk';
  return (
    <div className="flex flex-col gap-5 px-4 pb-10 pt-6 sm:px-7" data-testid="remote-disk">
      <Breadcrumb crumbs={crumbs} />
      <section className="glass-card flex flex-col gap-3 p-5 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex min-w-0 flex-col gap-1.5">
          <RemoteMarker name={lib.name} />
          <h1 data-testid="remote-disk-name" className="text-[26px] font-bold leading-tight [overflow-wrap:anywhere]" style={{ color: 'var(--ink)' }}>
            {heading}
          </h1>
          <span className="font-mono text-[12.5px]" style={{ color: 'var(--muted)' }}>
            {[v?.volume.filesystem, disk ? fmtSize(disk.sizeBytes) : null,
              v?.usage ? `${v.usage.percentUsed}% used · ${fmtSize(v.usage.freeBytes)} free` : null].filter(Boolean).join(' · ')}
          </span>
        </div>
        {actions}
      </section>
      {!files.ok ? (
        <div className="-mx-4 sm:-mx-7">
          <RemoteProblem libraryId={id} name={lib.name} host={lib.host} failure={files.failure} detail={files.detail}
                         retryHref={titleId ? remoteDiskHref(id, diskId, titleId) : `/remote/${encodeURIComponent(id)}/disks/${encodeURIComponent(diskId)}`} />
        </div>
      ) : 'unreadable' in files.value ? (
        <p data-testid="remote-files-unreadable" className="glass-card p-5 text-[13px]" style={{ color: 'var(--muted)' }}>
          This disk has no files to list: {files.value.unreadable || 'its filesystem could not be read'}.
        </p>
      ) : (
        <div className="glass-card overflow-hidden p-0" data-testid="remote-files">
          <div className="flex h-11 items-center border-b px-4 text-[12px] font-medium" style={{ borderColor: 'var(--line)', color: 'var(--muted-2)' }}>
            Files · read-only
          </div>
          <RemoteFileTree entries={files.value.root} />
        </div>
      )}
    </div>
  );
}
