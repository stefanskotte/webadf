import { Link } from '@/components/shell/link';
import type { GameDetailDisk } from '@/lib/queries';
import { WriteProtectToggle, WpSwitch } from './write-protect-toggle';
import { HelpTip } from '@/components/help/help-tip';
import { MountAction } from './mount-action';
import type { SendContext } from '@/lib/send-ui';
import { SendAdfButton } from '@/components/send/send-button';
import { ExtractAction } from './extract-action';
import { WEAK_BIT_NOTICE } from '@/lib/hfe/messages';
import { holderText, type MountChoice } from '@/lib/mount-choice';
import { DeleteDiskDialog } from '@/components/library/delete-disk-dialog';
import { libraryHref, type TrailView } from '@/lib/trail';
import { FobButton, type FobDevice } from '@/components/nfc/fob-button';
import { HdTag } from '@/components/disks/hd-tag';
import { isHdAdf } from '@/lib/disk-format';
import { DiskIcon } from '@/components/ui/disk-icon';
import { titleDiskColor } from '@/lib/library-look';
import { DiskSetMenu, LoneDiskMenu, type DiskSetControls } from './disk-set-menu';

export function DiskRow({ disk, gameId, choices, from, view = null, fobDevices = [], send = null, setControls, loneGameId, helpProtect, helpNfc, helpHfe, kind = null, authored = false }: {
  disk: GameDetailDisk;
  /** The title this disk is in: Files… opens the disk at LIBRARY:/<title>/<disk>. */
  gameId: string;
  /** Per-device verdict for THIS disk -- see lib/mount-choice.ts. */
  choices: MountChoice[];
  /**
   * The collection the person came from, so removing the last disk can lead
   * back there. Threaded rather than derived:
   * a game is in many collections and nothing downstream can work out which.
   */
  from?: string;
  /** The library's grid or table, carried with `from` (trail.ts TrailView). */
  view?: TrailView;
  /** Boards with a reader present; the fob button is drawn only when there is one. */
  fobDevices?: FobDevice[];
  /** Draw the write-protection "?" on this row -- one row per page, chosen by the parent. */
  helpProtect?: boolean;
  /** Draw the NFC "?" on this row -- one row per page, chosen by the parent. */
  helpNfc?: boolean;
  /** Draw the HFE "?" on this row -- the first HFE row per page, chosen by the parent. */
  helpHfe?: boolean;
  /**
   * Present only when the row is one of a disk set (two or more disks):
   * draws the ⋯ menu with Move up / Move down / Move out of set.
   */
  setControls?: DiskSetControls;
  /**
   * Present only when the row is a one-disk title's only disk: the id of that
   * title. Draws a ⋯ menu with "Add to a disk set…". Plain data, not a
   * callback, because the server page renders this row directly.
   */
  loneGameId?: string;
  /** Boards that can take files; null = no Send button (spec §4 "the disk row"). */
  send?: SendContext | null;
  /** The title's kind and authored flag, for the disk icon's colour (library-look titleDiskColor). */
  kind?: string | null;
  authored?: boolean;
}) {
  // Derived from the SAME choices the mount picker uses. It used to come from
  // a separate sha256-keyed map in the page, which could name a different
  // device than the button did whenever two disk rows shared one digest.
  const held = holderText(choices);
  const isHfe = disk.imageFormat === 'hfe';
  const isHd = isHdAdf(disk);
  // A board has CONFIRMED this disk: DF0 converged on it, or DF1 reports holding exactly its digest. A request still in
  // flight is not a hold (the hero's drive pill follows the same rule).
  const inDf0 = choices.some((c) => c.state === 'converged' && c.isThisDisk);
  const mounted = inDf0 || choices.some((c) => c.df1Held);
  const name = disk.tosecName ?? disk.sourceFilename ?? `Disk ${disk.diskNo}`;
  const color = titleDiskColor({ id: disk.id, hasHd: isHd, kind, formats: [disk.imageFormat], authored });
  const GHOST = 'btn-like inline-flex h-[38px] shrink-0 items-center rounded-[10px] border px-3 text-[13px] font-medium max-sm:min-h-11';
  const GHOST_STYLE = { background: 'var(--surface)', borderColor: 'var(--line)', color: 'var(--ink)' };
  const uploadedAs = disk.sourceFilename && disk.sourceFilename !== disk.tosecName ? disk.sourceFilename : null;

  return (
    <div
      // The controls drop to a line of their own below `sm`; from `sm` up this is the board's single row.
      className="glass-card flex flex-col gap-3 px-[18px] py-4 sm:flex-row sm:items-center sm:gap-[18px]"
      style={{ borderRadius: 16, ...(mounted ? { borderColor: 'var(--mounted-line)' } : {}) }}
      data-testid={`disk-${disk.id}`}
      // What e2e selects disk rows by: other disk controls' test ids also
      // start with "disk-" (disk-menu-*, disk-set-section, ...).
      data-disk-row=""
      data-mounted={mounted ? 'true' : undefined}
    >
      <div className="flex min-w-0 flex-1 items-center gap-[18px]">
        <DiskIcon color={color} size={56} hd={isHd} wp={disk.writeProtected || isHfe} mounted={mounted} drive={inDf0 ? 'DF0' : 'DF1'}
                  className="shrink-0" />
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-[15px] font-semibold" style={{ color: 'var(--ink)' }}>Disk {disk.diskNo}</span>
            {disk.isBoot && (
              <span className="rounded-full px-2 py-px text-[12px] font-semibold"
                    style={{ background: '#FCE6D6', color: '#8A3A0E' }}>Boot</span>
            )}
            <span className="rounded-full px-2 py-px font-mono text-[11px] font-semibold"
                  style={{ background: 'var(--track)', color: 'var(--muted)' }}
                  data-testid={`disk-format-${disk.id}`}>
              {isHfe ? <span data-testid={`hfe-tag-${disk.id}`}>HFE</span> : isHd ? 'ADF · HD' : 'ADF'}
            </span>
          </div>
          {/*
            TOSEC's name first, else the uploaded one. They disagree more often than you would expect -- one disk
            here is "[cr Nemesis]" to its uploader and "[cr NMS]" to TOSEC -- so when both exist the uploaded one
            moves to the meta line. `title` carries the full string, since either can be far wider than the row.
          */}
          {disk.tosecName ? (
            <span className="truncate font-mono text-[13px]" title={disk.tosecName}
                  style={{ color: 'var(--ink)' }} data-testid={`tosec-name-${disk.id}`}>
              {disk.tosecName}
            </span>
          ) : disk.sourceFilename ? (
            <span className="truncate font-mono text-[13px]" title={disk.sourceFilename}
                  style={{ color: 'var(--ink)' }} data-testid={`source-name-${disk.id}`}>
              {disk.sourceFilename}
            </span>
          ) : null}
          <span className="flex min-w-0 flex-wrap items-center gap-x-1.5 text-[12px]" style={{ color: 'var(--muted-2)' }}>
            {disk.tosecName && uploadedAs && (
              <span className="truncate" title={uploadedAs} data-testid={`source-name-${disk.id}`}>
                uploaded as {uploadedAs} ·
              </span>
            )}
            <span>{(disk.sizeBytes / 1024).toFixed(0)} KB</span>
            {isHd && <HdTag testId={`hd-tag-${disk.id}`} />}
            <span>· {disk.sha256.slice(0, 12)}</span>
          </span>
          {isHfe && (
            <span className="flex items-center gap-1.5 text-[12px]" style={{ color: 'var(--warning-fg)' }}
                  data-testid={`hfe-notice-${disk.id}`}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
                   strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className="shrink-0">
                <path d="M12 3l9 17H3z" /><path d="M12 10v4M12 17.5v.5" />
              </svg>
              {WEAK_BIT_NOTICE}
            </span>
          )}
          {held && (
            <span className="text-[12px] font-semibold"
                  style={{ color: held.stale ? 'var(--amber-text)' : 'var(--muted)' }}
                  data-testid={`holder-${disk.id}`}>
              {held.text}
            </span>
          )}
        </div>
      </div>
      {/*
        `sm:contents` so the controls are a wrapped block of their own on a phone and, from `sm` up, generate no
        box at all. Nothing here is portalled or absolutely positioned: the mount picker expands INLINE (see
        mount-action.tsx), and game-detail.spec.ts asserts that the next row's trigger sits below an open picker.
      */}
      <div className="flex flex-wrap items-center gap-2 sm:contents">
        {isHfe ? (
          // Stated, not hidden (show-both-values): an HFE is never writable.
          <span className="flex h-[38px] items-center gap-2.5 px-3 text-[13px] font-medium"
                style={{ color: 'var(--muted)' }}
                title="HFE disks are preserved originals: extract as ADF to change files"
                data-testid={`hfe-readonly-${disk.id}`}>
            <WpSwitch on />Read-only
          </span>
        ) : (
          <>
            <WriteProtectToggle diskId={disk.id} writeProtected={disk.writeProtected} />
            {helpProtect && <HelpTip topic="write-protect" />}
          </>
        )}
        {/*
          A plain anchor, not a fetch: the browser streams the response straight to disk and shows its own
          progress. No `download` attribute -- the server's Content-Disposition already names the file.
        */}
        <a href={`/api/disks/${disk.id}/adf`} data-testid={`download-${disk.id}`} className={GHOST} style={GHOST_STYLE}>
          Download
        </a>
        {/* Link, not <a>: an internal navigation to Files (increment 1, R1): the library on the left, this disk on the right. */}
        {isHfe ? (
          <ExtractAction diskId={disk.id} extractable={disk.extractable === true} reason={disk.extractReason}
                         help={helpHfe === true} />
        ) : (
          <Link href={`/files?left=LIBRARY:&right=${encodeURIComponent(`LIBRARY:/${gameId}/${disk.id}`)}&active=right`}
                data-testid={`files-${disk.id}`} className={GHOST} style={GHOST_STYLE}>
            Files…
          </Link>
        )}
        <MountAction diskId={disk.id} choices={choices} />
        {send && !isHfe && <SendAdfButton ctx={send} diskId={disk.id} />}
        {/* Write this disk onto an NFC tag, so tapping it mounts this disk. Before Delete. */}
        {fobDevices.length > 0 && (
          <FobButton testId={`fob-${disk.id}`} title={name}
                     disks={[{ id: disk.id, diskNo: disk.diskNo }]} devices={fobDevices} />
        )}
        {fobDevices.length > 0 && helpNfc && <HelpTip topic="nfc" />}
        {/* Named for the disk, not the title: on a multi-disk set this removes one ADF and leaves the rest. */}
        <DeleteDiskDialog
          kind="disk"
          id={disk.id}
          title={name}
          // Removing the last disk takes the title with it, and this page IS that title. Go where the
          // breadcrumb's own Library crumb goes, carrying the collection you arrived from.
          redirectWhenGone={libraryHref(from, view)}
        />
        {/* Set controls, after Delete: they rearrange the title rather than act on the disk. */}
        {setControls && <DiskSetMenu diskId={disk.id} name={name} controls={setControls} />}
        {!setControls && loneGameId && <LoneDiskMenu diskId={disk.id} gameId={loneGameId} name={name} />}
      </div>
    </div>
  );
}
