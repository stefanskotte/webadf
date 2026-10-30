'use client';

import { useId, useState } from 'react';
import { Modal } from '@/components/ui/modal';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { amigaNameProblem } from '@/lib/files/path';
import { refusalWords } from '@/lib/files/words';
import { Choice, DEFAULT_DENSITY, DEFAULT_FILESYSTEM, type Density, type Filesystem } from '@/components/library/create-adf';
import { managerReturnsFocus } from './dialogs';

/**
 * The words under the Name field, or null: the volume rules (R7), and with "Ask" a name already in the folder (R6).
 * The name is trimmed first, as the server trims it: " Work " is Work.
 */
export function createAdfProblem(name: string, taken: string[] | null): string | null {
  const trimmed = name.trim();
  const problem = amigaNameProblem(trimmed);
  if (problem) return refusalWords('bad_name', problem);
  const file = `${trimmed}.adf`.toLowerCase();
  return taken?.some((t) => t.toLowerCase() === file) ? refusalWords('name_exists') : null;
}

/**
 * Create ADF… in Files (spec §4): the Library's small form (Size, Filesystem: reset each time, since the dialog mounts
 * fresh) plus a Name, default "Untitled". `where` names the place in the title ("STASH:/Disks", "Demos"). `taken`: the
 * folder's names when the clash setting is "Ask" in STASH: (R6), else null (the server applies the setting).
 */
export function CreateAdfDialog({ where, taken, busy, onCreate, onCancel }: {
  where: string; taken: string[] | null; busy: boolean;
  onCreate(v: { name: string; filesystem: Filesystem; density: Density }): void; onCancel(): void;
}) {
  const [name, setName] = useState('Untitled');
  const [density, setDensity] = useState<Density>(DEFAULT_DENSITY);
  const [filesystem, setFilesystem] = useState<Filesystem>(DEFAULT_FILESYSTEM);
  const formId = useId();
  const problem = createAdfProblem(name, taken);
  const ready = !problem && !busy;
  return (
    <Modal open finalFocus={managerReturnsFocus} onOpenChange={(o) => { if (!o) onCancel(); }} width={440} testId="files-create-adf"
           closeTestId="files-create-adf-close" title="New blank disk" subtitle={`In ${where}`} dismissible={!busy}
           footer={(
             <div className="flex w-full items-center justify-end gap-2.5">
               <Button variant="outline" onClick={onCancel} disabled={busy}>Cancel</Button>
               <Button type="submit" form={formId} disabled={!ready} data-testid="files-create-adf-submit">{busy ? 'Creating…' : 'Create blank disk'}</Button>
             </div>
           )}>
      <form id={formId} className="flex flex-col gap-3 px-6 py-5 text-[14px]" style={{ color: 'var(--ink)' }}
            onSubmit={(e) => { e.preventDefault(); if (ready) onCreate({ name: name.trim(), filesystem, density }); }}>
        <label className="flex flex-col gap-1.5 text-[13px] font-medium">
          Name
          <Input autoFocus value={name} onChange={(e) => setName(e.target.value)} data-testid="files-create-adf-name"
                 aria-invalid={problem ? true : undefined} spellCheck={false} autoComplete="off" />
        </label>
        {problem && <p role="alert" data-testid="files-create-adf-problem" className="text-[13px]" style={{ color: 'var(--danger-fg)' }}>{problem}</p>}
        <Choice label="Size" testid="files-create-adf-size" value={density} onChange={setDensity}
                options={[{ value: 'dd', label: '880 KB', hint: 'Double density · every Amiga' }, { value: 'hd', label: '1.76 MB', hint: 'High density · needs Kickstart 3.x' }]} />
        <Choice label="Filesystem" testid="files-create-adf-fs" value={filesystem} onChange={setFilesystem}
                options={[{ value: 'FFS', label: 'FFS', hint: 'Fast File System · Kickstart 2.0+' }, { value: 'OFS', label: 'OFS', hint: 'Old File System · boots on Kickstart 1.x' }]} />
      </form>
    </Modal>
  );
}
