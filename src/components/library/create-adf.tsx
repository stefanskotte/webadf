'use client';

import { useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { toast } from 'sonner';
import { ChevronDownIcon, PlusIcon } from 'lucide-react';
import { Popover } from '@base-ui/react/popover';
import { Drawer } from '@base-ui/react/drawer';
import { ToggleGroup } from '@base-ui/react/toggle-group';
import { Toggle } from '@base-ui/react/toggle';
import { useMediaQuery } from '@base-ui/react/unstable-use-media-query';

type Density = 'dd' | 'hd';
type Filesystem = 'FFS' | 'OFS';

// The defaults, restored EVERY time the panel opens -- see below.
const DEFAULT_DENSITY: Density = 'dd';
const DEFAULT_FILESYSTEM: Filesystem = 'FFS';

/**
 * Make a blank Amiga disk, where you are standing.
 *
 * "Where you are standing" is literal: if the library is filtered to a
 * collection, the new disk joins that collection. The server resolves the id
 * against this org's own collections before filing anything, because
 * collection_games carries no org_id of its own (D-4-5).
 *
 * The disk is REAL as soon as this returns (operator's ruling): there is no
 * draft card. router.refresh() then brings it back from the server ordered
 * first, since the library is createdAt-descending (D9) -- the card does not
 * need to be faked into place.
 *
 * A small form: a Size switch, a Filesystem switch, a Create button
 * (operator's pick, 2026-09-28, over a four-item menu that had grown to
 * "Create HD ADF (OFS)"). The switches are two choices with two answers
 * each, which is what the disk actually is.
 *
 * NOTHING CARRIES OVER. This started as a <select> beside a button, and a
 * select keeps its value, so picking OFS once silently made every later disk
 * OFS. The switches here are reset to 880 KB / FFS each time the panel opens,
 * so the answer given for one disk is never the unasked answer for the next.
 * DD and FFS are the defaults (HD writes spec §6.3): HD is never preselected.
 *
 * A popover on a desktop, a bottom sheet on a phone -- the same form in both.
 */
export function CreateAdf() {
  const router = useRouter();
  const params = useSearchParams();
  const isPhone = useMediaQuery('(max-width: 639px)', {});
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [density, setDensity] = useState<Density>(DEFAULT_DENSITY);
  const [filesystem, setFilesystem] = useState<Filesystem>(DEFAULT_FILESYSTEM);

  function onOpenChange(next: boolean) {
    if (next) {
      setDensity(DEFAULT_DENSITY);
      setFilesystem(DEFAULT_FILESYSTEM);
    }
    setOpen(next);
  }

  async function create() {
    setBusy(true);
    try {
      const collectionId = params.get('collection');
      const res = await fetch('/api/disks/create', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ filesystem, density, ...(collectionId ? { collectionId } : {}) }),
      });
      if (!res.ok) {
        toast.error('Could not create the disk');
        return;
      }
      const body = await res.json().catch(() => null);
      toast.success(`Blank ${density === 'hd' ? 'HD ' : ''}${filesystem} disk created`, {
        description: body?.collectionId ? 'Added to this collection.' : 'Name it on its card.',
      });
      setOpen(false);
      router.refresh();
    } catch {
      toast.error('Could not reach the server');
    } finally {
      setBusy(false);
    }
  }

  const trigger = {
    'data-testid': 'create-adf',
    // The board's secondary button (spec 1.1): surface fill, line border, plus before and a muted chevron after.
    className: 'flex h-10 items-center gap-2 rounded-[10px] border px-3.5 text-[14px] font-medium disabled:opacity-50',
    style: { background: 'var(--surface)', borderColor: 'var(--line)', color: 'var(--ink)' },
    children: (
      <>
        <PlusIcon className="h-4 w-4" aria-hidden />
        {busy ? 'Creating…' : 'Create ADF'}
        <ChevronDownIcon className="h-3.5 w-3.5" style={{ color: 'var(--muted-2)' }} aria-hidden />
      </>
    ),
  };

  const form = (
    <CreateDiskForm
      density={density}
      filesystem={filesystem}
      busy={busy}
      onDensity={setDensity}
      onFilesystem={setFilesystem}
      onCreate={create}
    />
  );

  const panelStyle = {
    background: 'var(--surface)',
    color: 'var(--ink)',
    border: '1px solid var(--line)',
  };

  if (isPhone) {
    return (
      <Drawer.Root open={open} onOpenChange={onOpenChange}>
        <Drawer.Trigger {...trigger} />
        <Drawer.Portal>
          <Drawer.Backdrop className="fixed inset-0 z-50 min-h-dvh bg-black/40 transition-opacity duration-300 data-ending-style:opacity-0 data-starting-style:opacity-0" />
          <Drawer.Viewport className="fixed inset-0 z-50 flex items-end justify-center">
            <Drawer.Popup
              data-testid="create-adf-panel"
              className="w-full rounded-t-2xl px-4 pt-3 pb-[calc(1rem+env(safe-area-inset-bottom,0px))] outline-none [transform:translateY(var(--drawer-swipe-movement-y))] transition-transform duration-300 ease-[cubic-bezier(0.32,0.72,0,1)] data-ending-style:[transform:translateY(100%)] data-starting-style:[transform:translateY(100%)]"
              style={panelStyle}
            >
              <div className="mx-auto mb-3 h-1 w-10 rounded-full" style={{ background: 'var(--line-strong)' }} aria-hidden />
              <Drawer.Content>
                <Drawer.Title className="mb-3 text-[15px] font-bold">New blank disk</Drawer.Title>
                {form}
              </Drawer.Content>
            </Drawer.Popup>
          </Drawer.Viewport>
        </Drawer.Portal>
      </Drawer.Root>
    );
  }

  return (
    <Popover.Root open={open} onOpenChange={onOpenChange}>
      <Popover.Trigger {...trigger} />
      <Popover.Portal>
        {/* align="end": the trigger now sits second from the right of the header's actions, so the panel opens
            leftwards from its right edge rather than running off the page. */}
        <Popover.Positioner sideOffset={8} align="end" className="z-50">
          <Popover.Popup
            data-testid="create-adf-panel"
            className="w-[260px] rounded-xl p-3 shadow-lg outline-none transition-[scale,opacity] duration-100 data-ending-style:scale-[0.98] data-ending-style:opacity-0 data-starting-style:scale-[0.98] data-starting-style:opacity-0"
            style={panelStyle}
          >
            <Popover.Title className="mb-2 text-[13px] font-bold">New blank disk</Popover.Title>
            {form}
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}

function CreateDiskForm(props: {
  density: Density;
  filesystem: Filesystem;
  busy: boolean;
  onDensity: (d: Density) => void;
  onFilesystem: (f: Filesystem) => void;
  onCreate: () => void;
}) {
  return (
    <div className="flex flex-col gap-3">
      <Choice
        label="Size"
        testid="create-adf-size"
        value={props.density}
        onChange={props.onDensity}
        options={[
          { value: 'dd', label: '880 KB', hint: 'Double density · every Amiga' },
          { value: 'hd', label: '1.76 MB', hint: 'High density · needs Kickstart 3.x' },
        ]}
      />
      <Choice
        label="Filesystem"
        testid="create-adf-fs"
        value={props.filesystem}
        onChange={props.onFilesystem}
        options={[
          { value: 'FFS', label: 'FFS', hint: 'Fast File System · Kickstart 2.0+' },
          { value: 'OFS', label: 'OFS', hint: 'Old File System · boots on Kickstart 1.x' },
        ]}
      />
      <button
        type="button"
        data-testid="create-adf-submit"
        disabled={props.busy}
        onClick={props.onCreate}
        className="h-11 w-full rounded-lg text-[13px] font-semibold text-white disabled:opacity-50 sm:h-9"
        style={{ background: 'var(--primary-action)' }}
      >
        {props.busy ? 'Creating…' : 'Create blank disk'}
      </button>
    </div>
  );
}

/**
 * A two-way switch that always has exactly one answer. ToggleGroup lets the
 * pressed item be un-pressed (an empty value); that is ignored, so tapping
 * the current answer again leaves it chosen.
 */
function Choice<T extends string>(props: {
  label: string;
  testid: string;
  value: T;
  onChange: (v: T) => void;
  options: { value: T; label: string; hint: string }[];
}) {
  const hint = props.options.find((o) => o.value === props.value)?.hint;
  return (
    <div>
      <div className="mb-1 text-[11px] font-semibold" style={{ color: 'var(--faint)' }}>{props.label}</div>
      <ToggleGroup
        aria-label={props.label}
        value={[props.value]}
        onValueChange={(v) => { if (v[0]) props.onChange(v[0] as T); }}
        className="flex gap-1 rounded-lg border p-0.5"
        style={{ borderColor: 'var(--hairline)', background: 'var(--input-bg)' }}
      >
        {props.options.map((o) => (
          <Toggle
            key={o.value}
            value={o.value}
            data-testid={`${props.testid}-${o.value.toLowerCase()}`}
            className="h-11 flex-1 rounded-md text-[13px] font-semibold sm:h-8"
            style={o.value === props.value
              ? { background: 'var(--primary-action)', color: '#fff' }
              : { color: 'var(--muted)' }}
          >
            {o.label}
          </Toggle>
        ))}
      </ToggleGroup>
      <div className="mt-1 text-[11px]" style={{ color: 'var(--faint)' }}>{hint}</div>
    </div>
  );
}
