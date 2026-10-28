import { notFound } from 'next/navigation';
import { nowMs } from '@/lib/clock';
import { getDb } from '@/db';
import { requireOrg } from '@/lib/session';
import { listDevices } from '@/lib/queries';
import { mountChoices, holderText } from '@/lib/mount-choice';
import { listSendTargets } from '@/lib/send-targets';
import { isHdAdf } from '@/lib/disk-format';
import { fmtSize } from '@/lib/format';
import { kindTag, titleDiskColor } from '@/lib/library-look';
import { ID_RE, remotePaths } from '@/lib/remote/http';
import { hiddenDiskId } from '@/lib/remote/materialise';
import { loadRemote, remoteLibrary } from '@/lib/remote/pages';
import { checkTitleDetail } from '@/lib/remote/wire';
import { remoteDiskHref, remoteListItem, remoteTitleHref } from '@/lib/remote/view';
import { Breadcrumb } from '@/components/shell/breadcrumb';
import { Link } from '@/components/shell/link';
import { Cover, titleByline } from '@/components/library/cover';
import { DiskIcon } from '@/components/ui/disk-icon';
import { HdTag } from '@/components/disks/hd-tag';
import { SendBoardPicker } from '@/components/send/send-button';
import { RemoteMarker } from '@/components/remote/remote-marker';
import { RemoteProblem } from '@/components/remote/remote-problem';
import { RemoteDiskActions } from '@/components/remote/remote-disk-actions';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/**
 * An owner's title and its disks (library sharing spec §4.5): Mount in DF0:/DF1:, Send to Amiga, Download, and the
 * files of an ADF. Nothing that edits. Mount and Send ask the owner again (the listing here may be 60 s old), so a disk
 * taken out of scope since says "No longer shared" instead of mounting (Review Focus 1).
 */
export default async function RemoteTitlePage(props: PageProps<'/remote/[id]/titles/[titleId]'>) {
  const { orgId } = await requireOrg();
  const { id, titleId } = await props.params;
  if (!ID_RE.test(titleId)) notFound();
  const lib = await remoteLibrary(orgId, id);
  if (!lib) notFound();

  const libHref = `/remote/${encodeURIComponent(id)}`;
  const trail = (label: string) => (
    <Breadcrumb crumbs={[{ label: 'Remote', href: '/remote' }, { label: lib.name, href: libHref }, { label }]} />
  );

  const detail = lib.status === 'ended'
    ? { ok: false as const, failure: 'ended' as const }
    : await loadRemote(orgId, id, remotePaths.title(titleId), checkTitleDetail);
  if (!detail.ok) {
    return (
      <div className="flex flex-col gap-5 pb-10 pt-6">
        <div className="flex flex-col gap-3 px-4 sm:px-7">{trail('Title')}<RemoteMarker name={lib.name} /></div>
        <RemoteProblem libraryId={id} name={lib.name} host={lib.host} failure={detail.failure}
                       detail={'detail' in detail ? detail.detail : undefined} retryHref={remoteTitleHref(id, titleId)} />
      </div>
    );
  }

  const { title, disks } = detail.value;
  const g = remoteListItem(title, id);
  const [devices, sendTargets] = await Promise.all([listDevices(orgId), listSendTargets(getDb(), orgId)]);
  const now = nowMs();
  const send = sendTargets.length > 0 ? { targets: sendTargets, now } : null;
  const tag = title.kind ? kindTag(title.kind) : null;
  const byline = titleByline(g);
  const formats = disks.map((d) => d.imageFormat);
  const color = titleDiskColor({ id: title.id, hasHd: disks.some(isHdAdf), kind: title.kind, formats, authored: false });

  return (
    <div className="flex flex-col gap-6 px-4 pb-10 pt-6 sm:px-7" data-testid="remote-title">
      {trail(title.title)}
      <section className="flex flex-col gap-5 sm:flex-row sm:items-start">
        <div className="w-[160px] shrink-0 sm:w-[200px] [&>div]:m-0">
          <Cover game={g} holds={undefined} />
        </div>
        <div className="flex min-w-0 flex-col gap-2">
          <RemoteMarker name={lib.name} />
          <h1 data-testid="remote-title-name" className="text-[30px] font-bold leading-none [overflow-wrap:anywhere] sm:text-[40px] sm:tracking-[-0.02em]"
              style={{ color: 'var(--ink)' }}>
            {title.title}
          </h1>
          {byline && <span className="text-[14px]" style={{ color: 'var(--muted)' }}>{byline}</span>}
          <span className="flex flex-wrap items-center gap-2">
            {tag && <span className="rounded-full px-2 py-0.5 text-[12px] font-medium" style={{ background: tag.bg, color: tag.fg }}>{title.kind}</span>}
            <span className="font-mono text-[12px]" style={{ color: 'var(--muted-2)' }}>
              {disks.length === 1 ? '1 disk' : `${disks.length} disks`}
            </span>
          </span>
        </div>
      </section>

      <section aria-label="Disks" className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-[15px] font-semibold" style={{ color: 'var(--ink)' }}>Disks</h2>
          <SendBoardPicker ctx={send} />
        </div>
        {disks.length === 0 && (
          <p className="text-[14px]" style={{ color: 'var(--muted)' }}>No disks of this title are shared.</p>
        )}
        {disks.map((d) => {
          // The hidden row's id (materialise.ts), so a drive already holding this disk reads as holding it.
          const choices = mountChoices(devices, { id: hiddenDiskId(orgId, id, d.id), sha256: d.sha256, imageFormat: d.imageFormat, sizeBytes: d.sizeBytes }, now);
          const held = holderText(choices);
          const hd = isHdAdf(d);
          const ext = d.imageFormat === 'hfe' ? 'hfe' : 'adf';
          return (
            <div key={d.id} data-testid="remote-disk-row" data-disk-id={d.id}
                 className="glass-card flex flex-col gap-3 px-[18px] py-4 sm:flex-row sm:items-center sm:gap-[18px]"
                 style={{ borderRadius: 16 }}>
              <div className="flex min-w-0 flex-1 items-center gap-[18px]">
                <DiskIcon color={color} size={44} hd={hd} mounted={false} className="shrink-0" />
                <div className="flex min-w-0 flex-1 flex-col gap-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-[15px] font-semibold" style={{ color: 'var(--ink)' }}>Disk {d.diskNo}</span>
                    <span className="rounded-full px-2 py-px font-mono text-[11px] font-semibold uppercase"
                          style={{ background: 'var(--track)', color: 'var(--muted)' }}>{d.imageFormat}</span>
                    {hd && <HdTag testId={`remote-hd-${d.id}`} />}
                  </div>
                  {d.name && <span className="truncate font-mono text-[13px]" title={d.name} style={{ color: 'var(--ink)' }}>{d.name}</span>}
                  <span className="text-[12px]" style={{ color: 'var(--muted-2)' }}>{fmtSize(d.sizeBytes)}</span>
                  {held && (
                    <span className="text-[12px] font-semibold" data-testid={`remote-holder-${d.id}`}
                          style={{ color: held.stale ? 'var(--amber-text)' : 'var(--muted)' }}>{held.text}</span>
                  )}
                </div>
              </div>
              <div className="flex flex-wrap items-center gap-2 sm:justify-end">
                {d.imageFormat === 'adf' && (
                  <Link href={remoteDiskHref(id, d.id, title.id)} data-testid={`remote-files-${d.id}`}
                        className="btn-like inline-flex h-[38px] items-center rounded-[10px] border px-3 text-[13px] font-medium max-sm:min-h-11"
                        style={{ background: 'var(--surface)', borderColor: 'var(--line)', color: 'var(--ink)' }}>
                    Files
                  </Link>
                )}
                <RemoteDiskActions
                  where={{ libraryId: id, titleId: title.id, diskId: d.id, host: lib.host }}
                  choices={choices} send={d.imageFormat === 'adf' ? send : null}
                  filename={`${title.title} - Disk ${d.diskNo}.${ext}`} label={`${title.title}, disk ${d.diskNo}`} />
              </div>
            </div>
          );
        })}
      </section>
    </div>
  );
}
