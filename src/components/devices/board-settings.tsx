'use client';
import { useMemo, useRef, useState, useTransition, type RefObject } from 'react';
import { useRouter } from 'next/navigation';
import { Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import type { DeviceListItem } from '@/lib/queries';
import { describeI2cScan } from '@/lib/i2c-scan';
import type { BootDisk } from '@/lib/boot-disk';
import { Modal } from '@/components/ui/modal';
import { HelpTip } from '@/components/help/help-tip';
import { BootDiskSetting } from './boot-disk-setting';
import { DeleteDeviceConfirm } from './delete-device-dialog';

/** The NFC line is known to be wrong: the attention dot's rule (spec §8.3). A board that sends no scan is unknown,
 *  not wrong, so it gets no dot. */
function needsAttention(device: DeviceListItem): boolean {
  const i2c = describeI2cScan(device.nfcReader, device.i2cAddrs, device.firmwareVersion);
  return i2c !== null && !i2c.ok;
}

/**
 * Board settings (spec §8): the button in the card's heading row and the modal it opens. Disk at startup is a draft
 * that "Save to board" sends (Ruling 20); the NFC reader line is read-only (Ruling 22); "Delete device…" closes this
 * modal and opens the delete confirmation (Ruling 23). Cancel, the X, Escape and the backdrop send nothing, and none
 * of them works while the save runs.
 */
export function BoardSettings({ device }: { device: DeviceListItem }) {
  const id = device.id;
  const router = useRouter();
  const [, startRefresh] = useTransition();
  const [open, setOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [draft, setDraft] = useState<BootDisk>(device.bootDisk);
  // The server's value changed under us (our own save landing after the refresh, or another tab): the draft starts
  // from it again. Adjusting state during render, not in an effect (React docs: "storing information from previous renders").
  const [seenBootDisk, setSeenBootDisk] = useState(device.bootDisk);
  if (seenBootDisk !== device.bootDisk) { setSeenBootDisk(device.bootDisk); setDraft(device.bootDisk); }
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const deleting = useRef(false);
  // Focus returns to the opener whenever the modal or the confirmation closes; while the confirmation is the next
  // thing, the modal hands focus on to its Cancel button instead.
  const finalFocus = useMemo(() => ({
    get current() { return deleting.current ? cancelRef.current : triggerRef.current; },
  }) as RefObject<HTMLElement | null>, []);

  const attention = needsAttention(device);
  const i2c = describeI2cScan(device.nfcReader, device.i2cAddrs, device.firmwareVersion);
  const dirty = draft !== device.bootDisk;

  function show() {
    setDraft(device.bootDisk);
    setFailed(null);
    setOpen(true);
  }

  async function save() {
    setBusy(true);
    setFailed(null);
    try {
      const res = await fetch(`/api/devices/${id}/boot-disk`, {
        method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ mode: draft }),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => null) as { reason?: string } | null;
        setFailed(j?.reason ?? `Could not save (HTTP ${res.status})`);
        return;
      }
      setOpen(false);
      toast.success('Disk at startup saved. The board uses it at its next start.');
      startRefresh(() => router.refresh());
    } catch {
      setFailed('Could not reach the server');
    } finally { setBusy(false); }
  }

  function deleteOpenChange(next: boolean) {
    setDeleteOpen(next);
    if (!next) {
      deleting.current = false;
      requestAnimationFrame(() => triggerRef.current?.focus());
    }
  }

  return (
    <>
      <button ref={triggerRef} type="button" data-testid={`board-settings-${id}`} aria-haspopup="dialog"
              onClick={show}
              className="relative inline-flex h-8 shrink-0 items-center gap-1.5 rounded-[9px] border bg-transparent px-2.5 text-[13px] font-medium hover:bg-[var(--track)]"
              style={{ borderColor: 'var(--line)', color: 'var(--ink)' }}>
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
             strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <circle cx="12" cy="12" r="3" />
          <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" />
        </svg>
        Board settings
        {attention && (
          <>
            <span aria-hidden="true" data-testid={`board-settings-attention-${id}`}
                  className="absolute -right-0.5 -top-0.5 size-[7px] rounded-full" style={{ background: 'var(--fetch-dot)' }} />
            <span className="sr-only">: needs attention</span>
          </>
        )}
      </button>

      <Modal open={open} onOpenChange={setOpen} width={620} testId="board-settings-dialog"
             attrs={{ 'data-device-id': id }} closeTestId="board-settings-close" dismissible={!busy}
             finalFocus={finalFocus} title="Board settings"
             subtitle={`${device.name} · nothing changes until you save.`}
             footer={(
               <>
                 <button type="button" data-testid={`device-delete-${id}`} disabled={busy}
                         aria-label={`Delete ${device.name}`} title={`Delete ${device.name}`}
                         onClick={() => { deleting.current = true; setOpen(false); setDeleteOpen(true); }}
                         className="flex min-h-[38px] items-center gap-1.5 whitespace-nowrap rounded-[10px] px-2 text-[13px] font-medium hover:bg-[var(--danger-bg)] disabled:opacity-50"
                         style={{ color: 'var(--danger-fg)' }}>
                   <Trash2 size={14} strokeWidth={1.75} aria-hidden />
                   Delete device…
                 </button>
                 <span className="min-w-0 flex-1" />
                 <button type="button" data-testid="board-settings-cancel" disabled={busy}
                         onClick={() => setOpen(false)}
                         className="min-h-[38px] whitespace-nowrap rounded-[10px] border px-3.5 text-[13px] font-medium disabled:opacity-50"
                         style={{ background: 'var(--surface)', borderColor: 'var(--line)', color: 'var(--ink)' }}>
                   Cancel
                 </button>
                 <button type="button" data-testid="board-settings-save" disabled={!dirty || busy}
                         onClick={() => void save()}
                         className="min-h-[38px] whitespace-nowrap rounded-[10px] px-4 text-[13px] font-semibold disabled:opacity-50"
                         style={{ background: 'var(--ink)', color: 'var(--surface)' }}>
                   {busy ? 'Saving…' : 'Save to board'}
                 </button>
               </>
             )}>
        <div className="flex flex-col gap-[22px] px-6 py-5">
          <BootDiskSetting device={device} value={draft} onChange={setDraft} error={failed} busy={busy} />
          <div className="flex flex-col gap-2">
            <span className="text-[14px] font-semibold" style={{ color: 'var(--ink)' }}>NFC reader</span>
            <div className="flex items-center gap-3 rounded-[12px] px-3.5 py-3" style={{ background: 'var(--surface-2)' }}>
              {i2c ? (
                <>
                  <span aria-hidden="true" className="size-2 shrink-0 rounded-full"
                        style={{ background: i2c.ok ? 'var(--online-dot)' : 'var(--danger-fg)' }} />
                  <span className="flex min-w-0 flex-col gap-0.5" style={{ overflowWrap: 'anywhere' }}
                        data-testid={`device-nfc-${id}`} data-ok={i2c.ok}>
                    <span className="text-[13px] font-semibold" style={{ color: 'var(--ink)' }}>{i2c.line}</span>
                    {i2c.seen && (
                      <span className="font-mono text-[12px]" style={{ color: 'var(--muted)' }}
                            data-testid={`device-i2c-${id}`}>{i2c.seen}</span>
                    )}
                  </span>
                </>
              ) : (
                <span className="text-[13px]" style={{ color: 'var(--muted)' }} data-testid={`device-nfc-unknown-${id}`}>
                  This firmware does not report its reader (needs 1.17.0 or newer).
                </span>
              )}
            </div>
            <span className="flex items-start gap-1 text-[12px]" style={{ color: 'var(--muted-2)' }}>
              Tap a card written from a title to mount it; a Next-disk card moves to the next disk of the set.
              <HelpTip topic="nfc" className="-mt-1" />
            </span>
          </div>
        </div>
      </Modal>

      <DeleteDeviceConfirm deviceId={id} name={device.name} open={deleteOpen} onOpenChange={deleteOpenChange}
                           cancelRef={cancelRef} />
    </>
  );
}
