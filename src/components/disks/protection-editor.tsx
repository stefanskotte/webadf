'use client';

import { useState } from 'react';
import type { AdfEntry } from '@/lib/adffs';
import { bitsFromProtection, PROTECTION_FLAGS } from '@/lib/protection-bits';
import { useFileEdit } from './file-actions';

/**
 * Edit an entry's protection bits (A5): the eight flags its `----rwed` shows,
 * one toggle each, saved through PATCH files/[block] `{ protection }`. The
 * toggles read as the string does -- a lit letter is a flag that is on, so
 * "r" lit means readable, even though that bit is stored cleared.
 */
export function ProtectionEditor({ diskId, entry, onClose }: {
  diskId: string; entry: AdfEntry; onClose: () => void;
}) {
  const { busy, runEdit } = useFileEdit();
  const [shown, setShown] = useState(entry.protection);

  function flip(i: number) {
    const f = PROTECTION_FLAGS[i];
    setShown((s) => s.slice(0, i) + (s[i] === f.letter ? '-' : f.letter) + s.slice(i + 1));
  }

  function save() {
    const protection = bitsFromProtection(shown);
    runEdit(() => fetch(`/api/disks/${diskId}/files/${entry.block}`, {
      method: 'PATCH', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ protection }),
    }), `Protection of "${entry.name}" set to ${shown}`, onClose);
  }

  return (
    <div className="flex flex-wrap items-center gap-2 pl-[22px]" data-testid={`fs-protect-editor-${entry.block}`}>
      <div className="flex gap-1" role="group" aria-label={`Protection of ${entry.name}`}>
        {PROTECTION_FLAGS.map((f, i) => {
          const on = shown[i] === f.letter;
          return (
            <button key={f.letter} type="button" aria-pressed={on} title={f.label} onClick={() => flip(i)}
                    data-testid={`fs-protect-bit-${f.letter}`}
                    className="grid h-6 w-6 place-items-center rounded font-mono text-[11px] font-semibold"
                    style={on
                      ? { background: 'var(--primary-action)', color: 'white' }
                      : { background: 'var(--glass-strong)', color: 'var(--muted-2)' }}>
              {f.letter}
            </button>
          );
        })}
      </div>
      <button type="button" onClick={save} disabled={busy || shown === entry.protection}
              data-testid={`fs-protect-save-${entry.block}`}
              className="rounded px-2 py-0.5 text-[11px] font-semibold text-white disabled:opacity-50"
              style={{ background: 'var(--primary-action)' }}>
        Save
      </button>
      <button type="button" onClick={onClose} disabled={busy}
              className="rounded px-2 py-0.5 text-[11px] font-semibold disabled:opacity-50" style={{ color: 'var(--muted)' }}>
        Cancel
      </button>
    </div>
  );
}
