'use client';

import { useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';

export function DatUpload() {
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const router = useRouter();

  // Multiple files, imported one at a time. TOSEC ships the Amiga sets as
  // ~223 separate DATs and an operator realistically wants several of them
  // (Games - [ADF], Applications - [ADF], Games - Public Domain - [ADF], ...).
  // One-file-at-a-time would make a deliberately manual process unusable;
  // this keeps it manual without making it tedious. Sequential, not parallel:
  // each import is a large parse and the route is not worth stampeding.
  async function onChange(e: React.ChangeEvent<HTMLInputElement>) {
    const files = [...(e.target.files ?? [])];
    if (files.length === 0) return;
    setBusy(true);
    let ok = 0;
    let entries = 0;
    const failed: string[] = [];
    try {
      for (const file of files) {
        setProgress(`${file.name} (${ok + failed.length + 1}/${files.length})`);
        // Read in the browser and POST the raw text: the route takes
        // request.text(), so there is no multipart parsing on the server.
        const text = await file.text();
        let res: Response;
        try {
          res = await fetch('/api/admin/tosec', {
            method: 'POST',
            headers: { 'content-type': 'text/plain' },
            body: text,
          });
        } catch {
          // A network failure aborts the run: the rest would almost
          // certainly fail the same way, and a partial import is easier to
          // reason about than a long list of identical errors.
          toast.error('Could not reach the server', {
            description: `Stopped at ${file.name}. ${ok} of ${files.length} imported.`,
          });
          return;
        }
        const body = await res.json().catch(() => ({}));
        if (!res.ok) {
          // One bad file does not abandon the rest -- an operator selecting a
          // whole directory will inevitably include a non-DAT.
          failed.push(file.name);
          continue;
        }
        ok++;
        entries += body.imported ?? 0;
      }

      if (ok > 0) {
        toast.success(`Imported ${entries} entries from ${ok} file${ok === 1 ? '' : 's'}`, {
          description: failed.length > 0 ? `${failed.length} skipped: ${failed.join(', ')}` : undefined,
        });
      } else {
        toast.error('Nothing imported', {
          description: `${failed.length} file(s) rejected — are these really TOSEC DATs?`,
        });
      }
      router.refresh();
    } finally {
      setBusy(false);
      setProgress(null);
      if (input.current) input.current.value = '';
    }
  }

  return (
    <div className="flex flex-col gap-2">
      <label htmlFor="dat-file" className="text-[12.5px] font-semibold">
        Import a TOSEC DAT
      </label>
      <input
        id="dat-file"
        ref={input}
        type="file"
        accept=".dat,.xml"
        multiple
        disabled={busy}
        onChange={onChange}
        data-testid="dat-upload"
        className="text-[13px]"
      />
      <span className="text-[12px]" style={{ color: 'var(--muted)' }}>
        {busy
          ? `Importing ${progress ?? '…'}`
          : 'Select one or more .dat files. ClrMamePro or XML; re-importing a set updates it in place.'}
      </span>
    </div>
  );
}
