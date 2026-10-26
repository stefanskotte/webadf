'use client';

import { createContext, useContext, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { FolderPlus, Upload } from 'lucide-react';
import { ejectMessage, isMountedReason } from '@/lib/mount-wording';
import { HFE_READ_ONLY } from '@/lib/hfe/messages';

/**
 * Every AmigaDOS name field this app writes is 30 bytes (`bcplString(...,
 * 432, 30)` throughout src/lib/adffs, and write.ts refuses anything longer
 * with `name-too-long`). Every name input in this file enforces the same
 * cap, so a person is stopped while typing rather than told after a failed
 * upload.
 */
export const MAX_NAME_LENGTH = 30;

/** Why every edit control on the page is refused, and what to say about it. */
export type EditDisabled =
  | { reason: 'no-filesystem'; message: string }
  | { reason: 'bitmap-untrusted'; message: string }
  | { reason: 'mounted'; message: string }
  // Browsing an earlier version via `?version=` (time machine, Task 3): the
  // materialised tree is read-only regardless of the disk's own mount or
  // filesystem state, and the reason has to say so distinctly -- a person
  // reading "this disk is mounted" while looking at version 3 would think
  // ejecting the board gets them editing back, when returning to the head is
  // what actually does.
  | { reason: 'historical'; message: string };

/**
 * Turns one `reason` string from `{ error: 'edit_failed', reason }` (or the
 * handful of other error shapes the route family can answer with) into copy
 * a person can act on. Every reason the task-11 brief lists is named here
 * explicitly rather than falling through to a generic message, because
 * "disk-full" and "name-exists" call for different next steps.
 */
export function describeEditError(reason: string): string {
  // The 409 case: applyDiskEdit's own reason string, verbatim, naming the
  // device so the operator knows exactly where to eject from.
  if (isMountedReason(reason)) return ejectMessage(reason);
  switch (reason) {
    case 'disk-full': return 'The disk is full — there is no room for this change.';
    case 'name-too-long': return `Names are limited to ${MAX_NAME_LENGTH} characters.`;
    case 'name-exists': return 'Something with that name already exists here.';
    case 'not-found':
    case 'not_found':
      return 'That item is no longer on the disk.';
    case 'not-a-directory': return 'That is not a directory.';
    case 'bitmap-untrusted':
      return "This disk's allocation bitmap can't be trusted, so it can't be edited.";
    case 'no-filesystem': return 'This disk has no filesystem to edit.';
    case 'blob_unavailable': return 'The disk image could not be read from storage.';
    case 'hfe_read_only': return HFE_READ_ONLY;
    case 'changed_since':
      return 'The disk changed since, so going back would lose that. Use History to go back to an earlier version.';
    default: return reason;
  }
}

interface FileEditContextValue {
  diskId: string;
  disabled: EditDisabled | null;
  /** The disk's root directory block: 880 DD, 1,760 HD (HD writes spec §6.1).
   *  Every control that means "the root" sends this, never a constant. */
  rootBlock: number;
  busy: boolean;
  /**
   * Runs one write against this disk's file routes: `perform` issues the
   * fetch and returns its Response. Every caller -- the toolbar and every
   * row's rename/delete alike -- goes through this, so the identity-drop
   * confirmation (D-W-3), the disabled guard, error toasts and the
   * post-success refresh can never drift between them.
   *
   * `onSuccess`, when given, runs ONLY once the request actually succeeds --
   * never on a failed or unreachable request, and never merely because
   * `runEdit` was called (a caller that fires-and-forgets without it, like
   * the toolbar's upload/mkdir forms, keeps its existing clear-regardless
   * behaviour unchanged). It fires from the SAME place win or lose is
   * decided regardless of which path got there: the ordinary immediate
   * case, or the identity-drop confirmation dialog's deferred one -- a
   * caller with a reviewed batch worth not losing (`DropStaging`'s commit)
   * needs "cleared" to mean "written", not "attempted".
   */
  runEdit: (perform: () => Promise<Response>, successMessage: string, onSuccess?: () => void, opts?: RunEditOptions) => void;
}

export interface RunEditOptions {
  /**
   * The success toast offers Undo (A5): a restore of the version before the
   * one this edit recorded (the route answers its `seq`), refused by the
   * server when anything has written the disk since.
   */
  undoable?: boolean;
}

const FileEditContext = createContext<FileEditContextValue | null>(null);

export function useFileEdit(): FileEditContextValue {
  const ctx = useContext(FileEditContext);
  if (!ctx) throw new Error('useFileEdit must be used within a FileEditProvider');
  return ctx;
}

/**
 * Owns every piece of state a file edit needs that is NOT local to one
 * control: whether editing is refused at all, whether this disk's
 * TOSEC-identity warning has been shown yet this page visit, and the single
 * confirmation dialog for it. Wraps the toolbar and the tree so both share
 * the exact same gate.
 */
export function FileEditProvider({
  diskId, disabled, tosecName, rootBlock, children,
}: {
  diskId: string;
  disabled: EditDisabled | null;
  /**
   * Non-null ONLY when this disk currently matches a TOSEC entry (D-W-3) --
   * that is, `blobs.matchState === 'matched'` for its sha256, not merely
   * `disks.tosecName IS NOT NULL`. That column also holds the uploaded
   * filename (or, for an authored disk, `${volumeName}.adf` --
   * /api/disks/create) until a real match overwrites it, so a caller that
   * passes the raw column here would show this warning on every edit of
   * every disk, matched or not. See page.tsx's query comment for the join
   * that gets this right.
   */
  tosecName: string | null;
  /** From readVolume's `rootBlock` (page.tsx). */
  rootBlock: number;
  children: ReactNode;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  // Gates only the FIRST edit while `tosecName` is set. Once shown and
  // confirmed, later edits during the same page visit proceed straight
  // through -- the page only learns the identity was actually dropped on
  // its next full load, but re-asking every time would just be noise for
  // something the operator already confirmed.
  const [identityConfirmed, setIdentityConfirmed] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const pendingRef = useRef<(() => void) | null>(null);

  async function undo(seq: number) {
    try {
      const res = await fetch(`/api/disks/${diskId}/restore`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ seq: seq - 1, ifHead: seq }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        const reason = typeof body?.reason === 'string' ? body.reason
          : typeof body?.error === 'string' ? body.error
          : `the server answered ${res.status}`;
        toast.error("Couldn't undo that", { description: describeEditError(reason) });
        return;
      }
      toast.success('Undone');
      router.refresh();
    } catch {
      toast.error('Could not reach the server', { description: 'Nothing was undone.' });
    }
  }

  async function execute(perform: () => Promise<Response>, successMessage: string, onSuccess?: () => void, opts: RunEditOptions = {}) {
    setBusy(true);
    try {
      const res = await perform();
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        const reason = typeof body?.reason === 'string' ? body.reason
          : typeof body?.error === 'string' ? body.error
          : `the server answered ${res.status}`;
        toast.error('Could not make that change', { description: describeEditError(reason) });
        return;
      }
      const seq = opts.undoable ? (await res.json().catch(() => null))?.seq : null;
      if (typeof seq === 'number' && seq > 0) {
        toast.success(successMessage, { action: { label: 'Undo', onClick: () => void undo(seq) } });
      } else {
        toast.success(successMessage);
      }
      router.refresh();
      onSuccess?.();
    } catch {
      toast.error('Could not reach the server');
    } finally {
      setBusy(false);
    }
  }

  function runEdit(perform: () => Promise<Response>, successMessage: string, onSuccess?: () => void, opts?: RunEditOptions) {
    // The controls that call this are themselves disabled whenever
    // `disabled` is set -- this is the belt-and-braces guard, not the
    // primary one, in case a request is already in flight when the disk's
    // state changes under it.
    if (disabled) return;
    if (tosecName && !identityConfirmed) {
      pendingRef.current = () => { void execute(perform, successMessage, onSuccess, opts); };
      setConfirmOpen(true);
      return;
    }
    void execute(perform, successMessage, onSuccess, opts);
  }

  function confirmIdentityDrop() {
    setIdentityConfirmed(true);
    setConfirmOpen(false);
    const run = pendingRef.current;
    pendingRef.current = null;
    run?.();
  }

  function cancelIdentityDrop() {
    setConfirmOpen(false);
    pendingRef.current = null;
  }

  return (
    <FileEditContext.Provider value={{ diskId, disabled, busy, runEdit, rootBlock }}>
      {children}
      {/*
        Portalled to document.body, same reasoning as DeleteDiskDialog: this
        can be triggered from inside a .glass-card ancestor, and
        backdrop-filter on that ancestor would become the containing block
        for a `fixed` overlay nested inside it, wrecking the layout. `open`
        starts false and is only ever set from an event handler, so
        `document` is always available by the time this branch runs.
      */}
      {confirmOpen && createPortal((
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-4"
          style={{ background: 'var(--scrim)' }}
        >
          <div
            role="alertdialog"
            aria-modal="true"
            aria-label="This edit will drop the disk's TOSEC identity"
            data-testid="identity-confirm-dialog"
            className="glass-card wf-modal w-full max-w-[440px] p-6 text-left"
          >
            <h2 className="text-[20px] font-bold" style={{ fontFamily: 'var(--font-display)', color: 'var(--ink)' }}>
              This will drop the disk&apos;s TOSEC identity
            </h2>
            {/*
              Says what the edit DOES, not just "are you sure" -- the
              operator ruled 2026-09-01 that editing is the intended use of
              this catalog, not a mistake to be talked out of.
            */}
            <p className="mt-2 text-[13px]" style={{ color: 'var(--muted)' }}>
              This disk currently matches <strong style={{ color: 'var(--ink)' }}>{tosecName}</strong> in
              TOSEC. Editing it writes a new copy of the disk under a new checksum, and that copy will
              no longer match the entry — the catalog will show it by its own volume name instead. The
              original file is kept exactly as it is; this only affects the new copy you are about to
              create.
            </p>
            <div className="mt-5 flex items-center justify-end gap-2">
              <button
                type="button"
                data-testid="identity-confirm-cancel"
                onClick={cancelIdentityDrop}
                className="h-[38px] rounded-[10px] border px-4 text-[13px] font-medium hover:bg-[var(--track)]"
                style={{ background: 'var(--surface)', borderColor: 'var(--line)', color: 'var(--ink)' }}
              >
                Cancel
              </button>
              <button
                type="button"
                data-testid="identity-confirm-proceed"
                onClick={confirmIdentityDrop}
                className="h-[38px] rounded-[10px] px-4 text-[13px] font-semibold"
                style={{ background: 'var(--ink)', color: 'var(--surface)' }}
              >
                Edit anyway
              </button>
            </div>
          </div>
        </div>
      ), document.body)}
    </FileEditContext.Provider>
  );
}

/**
 * The two disk-root controls: upload a file, and create a new folder.
 * Both always add directly to the disk's root directory (block 880 on a DD
 * disk, 1,760 on an HD one) -- there is no per-row "add inside this folder"
 * yet, matching the scope this page's read-only browse already had.
 */
export function FileToolbar() {
  const { diskId, disabled, busy, runEdit, rootBlock } = useFileEdit();
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [uploadFile, setUploadFile] = useState<File | null>(null);
  const [uploadName, setUploadName] = useState('');
  const [folderOpen, setFolderOpen] = useState(false);
  const [folderName, setFolderName] = useState('');

  function onFileSelected(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploadFile(file);
    // Pre-filled from the OS filename, but already capped: the whole point
    // is that a too-long name is fixed here, not discovered from a 400
    // after the bytes have already gone over the wire.
    setUploadName(file.name.slice(0, MAX_NAME_LENGTH));
  }

  function cancelUpload() {
    setUploadFile(null);
    setUploadName('');
    if (fileInputRef.current) fileInputRef.current.value = '';
  }

  function submitUpload() {
    if (!uploadFile) return;
    const name = uploadName.trim();
    if (!name) return;
    const file = uploadFile;
    runEdit(() => {
      const form = new FormData();
      form.set('parentBlock', String(rootBlock));
      form.set('name', name);
      form.set('file', file);
      return fetch(`/api/disks/${diskId}/files`, { method: 'POST', body: form });
    }, `Uploaded "${name}"`);
    cancelUpload();
  }

  function cancelFolder() {
    setFolderOpen(false);
    setFolderName('');
  }

  function submitFolder() {
    const name = folderName.trim();
    if (!name) return;
    runEdit(() => {
      const form = new FormData();
      form.set('parentBlock', String(rootBlock));
      form.set('name', name);
      return fetch(`/api/disks/${diskId}/files`, { method: 'POST', body: form });
    }, `Created "${name}"`);
    cancelFolder();
  }

  const field = 'h-9 rounded-[9px] border px-2.5 text-[13px] focus-visible:outline-2 focus-visible:outline-(--ring) max-sm:min-h-11';
  const fieldStyle = { background: 'var(--surface)', borderColor: 'var(--line)', color: 'var(--ink)' };
  const ink = 'flex h-9 items-center gap-2 rounded-[9px] px-3 text-[13px] font-semibold disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--ring) max-sm:min-h-11';
  const inkStyle = { background: 'var(--ink)', color: 'var(--surface)' };
  const outline = 'flex h-9 items-center gap-2 rounded-[9px] border px-3 text-[13px] font-medium hover:bg-[var(--track)] disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-(--ring) max-sm:min-h-11';
  const outlineStyle = { background: 'var(--surface)', borderColor: 'var(--line)', color: 'var(--ink)' };

  return (
    <div className="flex flex-wrap items-center gap-2" data-testid="file-toolbar">
      <input
        ref={fileInputRef}
        type="file"
        onChange={onFileSelected}
        className="sr-only"
        tabIndex={-1}
        aria-hidden
        data-testid="upload-input"
      />
      {folderOpen ? (
        <div className="flex flex-wrap items-center gap-2">
          <input
            value={folderName}
            onChange={(e) => setFolderName(e.target.value.slice(0, MAX_NAME_LENGTH))}
            maxLength={MAX_NAME_LENGTH}
            aria-label="New folder name"
            data-testid="new-folder-name"
            autoFocus
            onKeyDown={(e) => {
              if (e.key === 'Enter') submitFolder();
              if (e.key === 'Escape') cancelFolder();
            }}
            className={field}
            style={fieldStyle}
          />
          <button type="button" onClick={submitFolder} disabled={busy || !folderName.trim()}
                  data-testid="new-folder-submit" className={ink} style={inkStyle}>
            {busy ? 'Creating…' : 'Create'}
          </button>
          <button type="button" onClick={cancelFolder} disabled={busy}
                  data-testid="new-folder-cancel" className={outline} style={outlineStyle}>
            Cancel
          </button>
        </div>
      ) : (
        <button type="button" onClick={() => setFolderOpen(true)} disabled={!!disabled} title={disabled?.message}
                data-testid="new-folder-trigger" className={outline} style={outlineStyle}>
          <FolderPlus size={15} aria-hidden />
          New folder
        </button>
      )}

      {uploadFile ? (
        <div className="flex flex-wrap items-center gap-2">
          <input
            value={uploadName}
            onChange={(e) => setUploadName(e.target.value.slice(0, MAX_NAME_LENGTH))}
            maxLength={MAX_NAME_LENGTH}
            aria-label="Name for the uploaded file"
            data-testid="upload-name"
            className={field}
            style={fieldStyle}
          />
          <button type="button" onClick={submitUpload} disabled={busy || !uploadName.trim()}
                  data-testid="upload-submit" className={ink} style={inkStyle}>
            {busy ? 'Uploading…' : 'Upload'}
          </button>
          <button type="button" onClick={cancelUpload} disabled={busy}
                  data-testid="upload-cancel" className={outline} style={outlineStyle}>
            Cancel
          </button>
        </div>
      ) : (
        <button type="button" onClick={() => fileInputRef.current?.click()} disabled={!!disabled} title={disabled?.message}
                data-testid="upload-trigger" className={ink} style={inkStyle}>
          <Upload size={15} aria-hidden />
          Add file
        </button>
      )}
    </div>
  );
}
