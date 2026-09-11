'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';

/**
 * The device's label, editable in place.
 *
 * A drive starts out called "Device <MAC>", which is a fine identifier and a
 * poor name: the mount picker in the library asks you to choose between drives,
 * and a column of same-shaped MACs is the worst thing to choose between. The
 * MAC is not replaced by this -- it is its own column and stays on the card
 * directly below.
 */
export function DeviceAlias({ deviceId, name, isDefault }: {
  deviceId: string;
  name: string;
  /** True when `name` is still the MAC stand-in, i.e. nobody has named it. */
  isDefault: boolean;
}) {
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(name);
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  // Seeding the field belongs in the CLICK, not in an effect. Doing it in an
  // effect is a setState during render-commit, which react-hooks/set-state-in-
  // effect rejects and which costs a second render for no reason -- the value
  // is known at the moment the editor is asked for. The effect that remains
  // only moves focus, which is a DOM side effect and nothing else.
  function beginEdit() {
    // Open EMPTY on a default name: nobody wants to delete a MAC before typing.
    setValue(isDefault ? '' : name);
    setEditing(true);
  }

  useEffect(() => {
    if (editing) {
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [editing]);

  async function save() {
    if (busy) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/devices/${deviceId}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ alias: value }),
      });
      if (!res.ok) {
        toast.error('Could not rename', { description: `The server answered ${res.status}.` });
        return;
      }
      setEditing(false);
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  if (editing) {
    return (
      <div className="flex flex-wrap items-center gap-2">
        <input
          ref={inputRef}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          // Enter saves, Escape abandons. Both are what a person expects from
          // an inline field, and neither is discoverable without being there.
          onKeyDown={(e) => {
            if (e.key === 'Enter') { e.preventDefault(); void save(); }
            if (e.key === 'Escape') { e.preventDefault(); setEditing(false); }
          }}
          maxLength={80}
          // The empty case is the useful one to explain: it is not an error,
          // it puts the MAC label back.
          placeholder="Name this drive — empty restores the MAC"
          aria-label="Device name"
          data-testid={`alias-input-${deviceId}`}
          className="min-w-0 flex-1 rounded-lg border px-2.5 py-1.5 text-[14px] font-semibold sm:w-64 sm:flex-none"
          style={{ borderColor: 'var(--hairline)', background: 'var(--glass-strong)', color: 'var(--ink)' }}
        />
        <button type="button" onClick={() => void save()} disabled={busy}
                data-testid={`alias-save-${deviceId}`}
                className="rounded-lg px-3 py-1.5 text-[12px] font-semibold text-white disabled:opacity-50"
                style={{ background: 'var(--primary-action)' }}>
          {busy ? 'Saving…' : 'Save'}
        </button>
        <button type="button" onClick={() => setEditing(false)} disabled={busy}
                data-testid={`alias-cancel-${deviceId}`}
                className="rounded-lg border px-3 py-1.5 text-[12px] font-semibold"
                style={{ borderColor: 'var(--hairline)', color: 'var(--muted)' }}>
          Cancel
        </button>
      </div>
    );
  }

  return (
    <div className="flex min-w-0 items-center gap-2">
      <span className="truncate text-[16px] font-bold" style={{ color: 'var(--ink)' }}
            data-testid={`device-name-${deviceId}`}>
        {name}
      </span>
      <button type="button" onClick={beginEdit}
              data-testid={`alias-edit-${deviceId}`}
              className="shrink-0 rounded-lg border px-2 py-0.5 text-[11px] font-semibold"
              style={{ borderColor: 'var(--hairline)', color: 'var(--muted)' }}>
        {/* "Name" while it is still wearing its MAC, "Rename" once it is not:
            the first is an invitation, the second is a correction. */}
        {isDefault ? 'Name' : 'Rename'}
      </button>
    </div>
  );
}
