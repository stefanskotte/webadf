'use client';

import { useId, useState } from 'react';
import { Modal } from '@/components/ui/modal';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { ProtectionCells } from '@/components/disks/protection-cells';
import type { FsEntry } from '@/lib/files/types';
import { AMIGA_COMMENT_MAX, amigaNameProblem } from '@/lib/files/path';
import { refusalWords } from '@/lib/files/words';
import { PROTECTION_FLAGS, bitsFromProtection } from '@/lib/protection-bits';
import type { ClashChoice } from '@/lib/files/transfer';
import { deleteText, type DeleteWhere } from '@/lib/files/pane-rules';
import { paneSize } from './pane';

export type { ClashChoice };
// The delete words are pure and live with the pane rules (increment 3); the dialogs' callers and tests import them here.
export { deleteText, deleteWhat, placeName } from '@/lib/files/pane-rules';

/**
 * The Files manager's dialogs (spec 2026-10-29 §5), all on the shared Modal. Each is mounted only while open and
 * reports a choice; the manager runs the operation. `busy` is true while that request runs: the dialog then stays
 * put and cannot be dismissed.
 */

export type Clash = { source: string; name: string; dest: string };

/**
 * Every Files dialog's `finalFocus`: Base UI moves no focus on close. The dialogs unmount as they close, and Base UI's
 * own return then lands on a stale element; the manager (files-manager.tsx) puts focus back itself, on the opener or
 * on the manager.
 */
export const managerReturnsFocus = () => false;

const foot = 'flex w-full items-center justify-end gap-2.5';
const body = 'flex flex-col gap-3 px-6 py-5 text-[14px]';
const ink = { color: 'var(--ink)' } as const;

/**
 * One clash at a time: Replace, Skip or Keep both, with "Do this for all" when more are waiting. Each answer goes
 * back to the manager, which asks again for the next clash or runs the copy once every clash has an answer.
 */
export function ClashDialog({ clash, remaining, busy, onChoose, onCancel }: {
  clash: Clash; remaining: number; busy: boolean;
  onChoose(choice: ClashChoice, forAll: boolean): void; onCancel(): void;
}) {
  const [forAll, setForAll] = useState(false);
  const id = useId();
  return (
    <Modal open finalFocus={managerReturnsFocus} onOpenChange={(o) => { if (!o) onCancel(); }} width={440} testId="files-clash-dialog"
           closeTestId="files-clash-close" title="That name is taken" dismissible={!busy}
           subtitle={remaining > 1 ? `${remaining} items clash` : undefined}
           footer={(
             <div className={foot}>
               <Button variant="outline" onClick={onCancel} disabled={busy} data-testid="files-clash-cancel">Cancel</Button>
               <Button variant="outline" onClick={() => onChoose('skip', forAll)} disabled={busy} data-testid="files-clash-skip">Skip</Button>
               <Button variant="outline" onClick={() => onChoose('keep-both', forAll)} disabled={busy} data-testid="files-clash-keep-both">Keep both</Button>
               <Button onClick={() => onChoose('replace', forAll)} disabled={busy} data-testid="files-clash-replace">Replace</Button>
             </div>
           )}>
      <div className={body} style={ink}>
        <p data-testid="files-clash-text">
          Something called <b className="font-semibold [overflow-wrap:anywhere]">{clash.name}</b> is already there.
          Replace it, skip this one, or keep both (the copy gets a new name)?
        </p>
        {remaining > 1 && (
          <label htmlFor={id} className="flex items-center gap-2 text-[13px]" style={{ color: 'var(--muted)' }}>
            <input id={id} type="checkbox" checked={forAll} onChange={(e) => setForAll(e.target.checked)}
                   data-testid="files-clash-all" className="h-3.5 w-3.5" style={{ accentColor: 'var(--accent-amber)' }} />
            Do this for all {remaining}
          </label>
        )}
      </div>
    </Modal>
  );
}

/**
 * The delete confirm. In NET: (R4) it cancels what waits and clears what finished: its title and button say that
 * instead, and the way out reads Keep, so it is never two buttons that both say Cancel.
 */
export function ConfirmDeleteDialog({ entries, where, busy, onConfirm, onCancel }: {
  entries: FsEntry[]; where: DeleteWhere; busy: boolean; onConfirm(): void; onCancel(): void;
}) {
  const net = where === 'NET:';
  const title = net ? (entries.length === 1 ? 'Take this file off the queue?' : 'Take these files off the queue?')
    : entries.length === 1 ? 'Delete this item?' : 'Delete these items?';
  return (
    <Modal open finalFocus={managerReturnsFocus} onOpenChange={(o) => { if (!o) onCancel(); }} width={440} testId="files-delete-dialog"
           closeTestId="files-delete-close" title={title}
           dismissible={!busy}
           footer={(
             <div className={foot}>
               <Button variant="outline" onClick={onCancel} disabled={busy}>{net ? 'Keep' : 'Cancel'}</Button>
               <Button variant="destructive" onClick={onConfirm} disabled={busy} data-testid="files-delete-confirm">
                 {net ? (busy ? 'Working…' : 'Cancel / clear') : busy ? 'Deleting…' : 'Delete'}
               </Button>
             </div>
           )}>
      <div className={body} style={ink}>
        <p data-testid="files-delete-text" className="[overflow-wrap:anywhere]">
          {deleteText(entries, where)}
        </p>
      </div>
    </Modal>
  );
}

/**
 * Makedir and Rename: one name, checked as it is typed against the AmigaDOS rules and the names already in the
 * folder (`taken`, compared case-insensitively as AmigaDOS does; the server has the last word).
 */
export function NameDialog({ mode, initial, taken, busy, onSave, onCancel }: {
  mode: 'makedir' | 'rename'; initial: string; taken: string[]; busy: boolean;
  onSave(name: string): void; onCancel(): void;
}) {
  const [name, setName] = useState(initial);
  const formId = useId();
  const problem = amigaNameProblem(name);
  const clashes = !problem && name.toLowerCase() !== initial.toLowerCase()
    && taken.some((t) => t.toLowerCase() === name.toLowerCase());
  const unchanged = mode === 'rename' && name === initial;
  const message = problem ? refusalWords('bad_name', problem) : clashes ? refusalWords('name_exists') : null;
  const ready = !problem && !clashes && !unchanged && !busy;
  return (
    <Modal open finalFocus={managerReturnsFocus} onOpenChange={(o) => { if (!o) onCancel(); }} width={440} testId="files-name-dialog"
           closeTestId="files-name-close" title={mode === 'makedir' ? 'New folder' : `Rename ${initial}`}
           dismissible={!busy}
           footer={(
             <div className={foot}>
               <Button variant="outline" onClick={onCancel} disabled={busy}>Cancel</Button>
               <Button type="submit" form={formId} disabled={!ready} data-testid="files-name-save">
                 {mode === 'makedir' ? (busy ? 'Making…' : 'Make folder') : (busy ? 'Renaming…' : 'Rename')}
               </Button>
             </div>
           )}>
      <form id={formId} className={body} style={ink}
            onSubmit={(e) => { e.preventDefault(); if (ready) onSave(name); }}>
        <label className="flex flex-col gap-1.5 text-[13px] font-medium">
          Name
          <Input autoFocus value={name} onChange={(e) => setName(e.target.value)} data-testid="files-name-input"
                 aria-invalid={message && name !== initial ? true : undefined} spellCheck={false} autoComplete="off" />
        </label>
        {/* Quiet until something was typed: an empty Makedir field is not yet a mistake. */}
        {message && name !== initial && (
          <p role="alert" data-testid="files-name-problem" className="text-[13px]" style={{ color: 'var(--danger-fg)' }}>{message}</p>
        )}
      </form>
    </Modal>
  );
}

/** A flag across the selection: on for all, off for all, or mixed. */
export type Tri = 'on' | 'off' | 'mixed';

/** Each of the eight flags over every entry's protection string (`----rwed` order). */
export function triState(protections: string[]): Tri[] {
  return PROTECTION_FLAGS.map((f, i) => {
    const ons = protections.filter((p) => p[i] === f.letter).length;
    return ons === protections.length ? 'on' : ons === 0 ? 'off' : 'mixed';
  });
}

/**
 * The eight protection flags for one or many entries. A flag the selection disagrees on starts mixed; one
 * operation sets ONE protection on every entry (one new version), so each mixed flag must be decided before Save.
 */
export function ProtectDialog({ entries, busy, onSave, onCancel }: {
  entries: FsEntry[]; busy: boolean; onSave(protection: number): void; onCancel(): void;
}) {
  const start = triState(entries.map((e) => e.protection ?? '----rwed'));
  const [flags, setFlags] = useState<Tri[]>(start);
  const mixed = flags.includes('mixed');
  const changed = flags.some((f, i) => f !== start[i]);
  const shown = PROTECTION_FLAGS.map((f, i) => (flags[i] === 'on' ? f.letter : '-')).join('');
  const flip = (i: number) => setFlags((fs) => fs.map((f, j) => (j === i ? (f === 'on' ? 'off' : 'on') : f)));
  return (
    <Modal open finalFocus={managerReturnsFocus} onOpenChange={(o) => { if (!o) onCancel(); }} width={440} testId="files-protect-dialog"
           closeTestId="files-protect-close" dismissible={!busy}
           title={entries.length === 1 ? `Protection of ${entries[0].name}` : `Protection of ${entries.length} items`}
           footer={(
             <div className={foot}>
               <Button variant="outline" onClick={onCancel} disabled={busy}>Cancel</Button>
               <Button onClick={() => onSave(bitsFromProtection(shown))} disabled={busy || mixed || !changed}
                       data-testid="files-protect-save">{busy ? 'Saving…' : 'Save'}</Button>
             </div>
           )}>
      <div className={body} style={ink}>
        <div className="flex flex-wrap gap-1.5" role="group" aria-label="Protection flags">
          {PROTECTION_FLAGS.map((f, i) => {
            const state = flags[i];
            return (
              <button key={f.letter} type="button" title={state === 'mixed' ? `${f.label}: mixed` : f.label}
                      aria-pressed={state === 'mixed' ? 'mixed' : state === 'on'} onClick={() => flip(i)} disabled={busy}
                      data-testid={`files-protect-bit-${f.letter}`} data-state={state}
                      className="grid h-[34px] w-[34px] place-items-center rounded-[8px] font-mono text-[12px] font-semibold disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-(--ring)"
                      style={state === 'on' ? { background: 'var(--ink)', color: 'var(--surface)' }
                        : state === 'mixed' ? { background: 'var(--warning-bg)', color: 'var(--warning-fg)', boxShadow: 'inset 0 0 0 1px var(--line-strong)' }
                        : { background: 'var(--track)', color: 'var(--muted-2)' }}>
                {state === 'mixed' ? '~' : f.letter}
              </button>
            );
          })}
        </div>
        <ul className="flex flex-col gap-0.5 text-[12px]" style={{ color: 'var(--muted)' }}>
          {PROTECTION_FLAGS.map((f) => <li key={f.letter}><span className="font-mono font-semibold">{f.letter}</span> {f.label}</li>)}
        </ul>
        {mixed && (
          <p data-testid="files-protect-mixed" className="text-[13px]" style={{ color: 'var(--warning-fg)' }}>
            The items differ on the flags marked ~. Click each to set it on or off for all of them.
          </p>
        )}
      </div>
    </Modal>
  );
}

/**
 * One entry's details; the comment is editable where the place can be written (a disk, or STASH: -- not an archive),
 * with the 79-character counter.
 */
export function InfoDialog({ entry, writable, busy, onSaveComment, onClose }: {
  entry: FsEntry; writable: boolean; busy: boolean; onSaveComment(comment: string): void; onClose(): void;
}) {
  const [comment, setComment] = useState(entry.comment ?? '');
  const formId = useId();
  const tooLong = comment.length > AMIGA_COMMENT_MAX;
  const changed = comment !== (entry.comment ?? '');
  const row = 'grid grid-cols-[96px_minmax(0,1fr)] gap-2 text-[13px]';
  const label = { color: 'var(--muted)' } as const;
  return (
    <Modal open finalFocus={managerReturnsFocus} onOpenChange={(o) => { if (!o) onClose(); }} width={440} testId="files-info-dialog"
           closeTestId="files-info-close" title={entry.name} dismissible={!busy}
           subtitle={entry.kind === 'dir' ? 'Folder' : entry.kind === 'archive' ? 'Archive' : 'File'}
           footer={(
             <div className={foot}>
               <Button variant="outline" onClick={onClose} disabled={busy}>{writable && changed ? 'Cancel' : 'Close'}</Button>
               {writable && (
                 <Button type="submit" form={formId} disabled={busy || !changed || tooLong} data-testid="files-info-save">
                   {busy ? 'Saving…' : 'Save'}
                 </Button>
               )}
             </div>
           )}>
      <form id={formId} className={body} style={ink}
            onSubmit={(e) => { e.preventDefault(); if (writable && changed && !tooLong && !busy) onSaveComment(comment); }}>
        <div className={row}><span style={label}>Name</span><span className="[overflow-wrap:anywhere]">{entry.name}</span></div>
        <div className={row}><span style={label}>Size</span>
          <span className="font-mono">{(entry.kind === 'file' || entry.kind === 'archive') && entry.size !== null ? `${paneSize(entry.size)} (${entry.size.toLocaleString()} bytes)` : '—'}</span></div>
        <div className={row}><span style={label}>Date</span>
          <span className="font-mono">{entry.date ? entry.date.slice(0, 19).replace('T', ' ') : '—'}</span></div>
        <div className={row}><span style={label}>Protection</span>
          <span className="flex gap-0.5 font-mono text-[11px] font-semibold">
            {entry.protection ? <ProtectionCells protection={entry.protection} /> : '—'}
          </span></div>
        <label className="flex flex-col gap-1.5 text-[13px]">
          <span className="flex items-baseline justify-between">
            <span style={label}>Comment</span>
            <span data-testid="files-info-count" className="font-mono text-[12px]"
                  style={{ color: tooLong ? 'var(--danger-fg)' : 'var(--muted-2)' }}>{comment.length}/{AMIGA_COMMENT_MAX}</span>
          </span>
          <Input value={comment} onChange={(e) => setComment(e.target.value)} readOnly={!writable || busy}
                 data-testid="files-info-comment" aria-invalid={tooLong || undefined} spellCheck={false} autoComplete="off" />
        </label>
        {tooLong && <p role="alert" className="text-[13px]" style={{ color: 'var(--danger-fg)' }}>{refusalWords('comment_too_long')}</p>}
      </form>
    </Modal>
  );
}
