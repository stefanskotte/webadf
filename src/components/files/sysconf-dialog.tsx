'use client';

import { useId, useState, type ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Modal } from '@/components/ui/modal';
import { SegRadioGroup } from '@/components/ui/seg-radio-group';
import {
  DOUBLE_CLICK_US, KEY_DELAY_US, KEY_SPEED_US, OVERSCAN_POSITION_MAX, OVERSCAN_SIZE_MAX, SYSCONF_NAME, SYSCONF_SIZE, sysconfDefaults, sysconfSchema, type SysconfSettings,
} from '@/lib/files/sysconf';
import { managerReturnsFocus } from './dialogs';
import { PointerEditor } from './pointer-editor';
import { colorToCss, cssToColor } from './sysconf-colors';

export { colorToCss, cssToColor };

type Typed = 'viewX' | 'viewY' | 'extraRows' | 'extraColumns' | 'keyDelay' | 'keySpeed' | 'doubleClick';
/** What the dialog holds: everything typed stays as typed, so an emptied field is a reason and not a number. */
export type SysconfDraft = Omit<SysconfSettings, 'viewX' | 'viewY' | 'extraRows' | 'extraColumns' | 'keyDelayUs' | 'keySpeedUs' | 'doubleClickUs'> & Record<Typed, string>;

export function draftOf(s: SysconfSettings): SysconfDraft {
  const { viewX, viewY, extraRows, extraColumns, keyDelayUs, keySpeedUs, doubleClickUs, ...rest } = s;
  const seconds = (us: number) => (us / 1000000).toFixed(2);
  return { ...rest, viewX: String(viewX), viewY: String(viewY), extraRows: String(extraRows), extraColumns: String(extraColumns),
    keyDelay: seconds(keyDelayUs), keySpeed: seconds(keySpeedUs), doubleClick: seconds(doubleClickUs) };
}

function whole(text: string, max: number): number | null {
  if (!/^-?\d+$/.test(text.trim())) return null;
  const n = Number(text);
  return Math.abs(n) <= max ? n : null;
}
function micros(text: string, r: { min: number; max: number }): number | null {
  if (!/^\d+(\.\d+)?$/.test(text.trim())) return null;
  const n = Math.round(Number(text) * 1000000);
  return n >= r.min && n <= r.max ? n : null;
}

/** The settings, or the words saying the first thing wrong. */
export function settingsOf(d: SysconfDraft): { settings: SysconfSettings } | { problem: string } {
  const { viewX, viewY, extraRows, extraColumns, keyDelay, keySpeed, doubleClick, ...rest } = d;
  const pos = [whole(viewX, OVERSCAN_POSITION_MAX), whole(viewY, OVERSCAN_POSITION_MAX)];
  if (pos.includes(null)) return { problem: `Overscan position must be a whole number from -${OVERSCAN_POSITION_MAX} to ${OVERSCAN_POSITION_MAX}.` };
  const size = [whole(extraRows, OVERSCAN_SIZE_MAX), whole(extraColumns, OVERSCAN_SIZE_MAX)];
  if (size.includes(null)) return { problem: `Overscan size must be a whole number from -${OVERSCAN_SIZE_MAX} to ${OVERSCAN_SIZE_MAX}.` };
  const seconds = (r: { min: number; max: number }) => `from ${r.min / 1000000} to ${r.max / 1000000} seconds`;
  const delay = micros(keyDelay, KEY_DELAY_US);
  if (delay === null) return { problem: `Key repeat delay must be ${seconds(KEY_DELAY_US)}.` };
  const speed = micros(keySpeed, KEY_SPEED_US);
  if (speed === null) return { problem: `Key repeat speed must be ${seconds(KEY_SPEED_US)}.` };
  const click = micros(doubleClick, DOUBLE_CLICK_US);
  if (click === null) return { problem: `Double-click time must be ${seconds(DOUBLE_CLICK_US)}.` };
  const parsed = sysconfSchema.safeParse({ ...rest, viewX: pos[0], viewY: pos[1], extraRows: size[0], extraColumns: size[1],
    keyDelayUs: delay, keySpeedUs: speed, doubleClickUs: click });
  return parsed.success ? { settings: parsed.data } : { problem: 'Those settings are not valid.' };
}

const BOOT_ONLY = 'read at boot only';
function Group({ title, note, children }: { title: string; note?: string; children: ReactNode }) {
  return (
    <fieldset className="flex flex-col gap-2 border-b py-3 last:border-b-0" style={{ borderColor: 'var(--line)' }}>
      <legend className="float-left mb-2 w-full text-[11px] font-semibold uppercase tracking-wide" style={{ color: 'var(--faint)' }}>
        {title}{note && <span className="ml-1.5 font-normal normal-case tracking-normal">{note}</span>}
      </legend>
      {children}
    </fieldset>
  );
}
function Row({ label, labelId, note, children }: { label: string; labelId?: string; note?: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-1 items-center gap-x-3 gap-y-1 text-[13px] sm:grid-cols-[150px_1fr]">
      <span id={labelId}>{label}</span>
      <div className="flex flex-wrap items-center gap-2">{children}{note && <span className="text-[12px]" style={{ color: 'var(--faint)' }}>{note}</span>}</div>
    </div>
  );
}
function Num({ label, name, value, testId, onChange, suffix }: { label: string; name?: string; value: string; testId: string; onChange(v: string): void; suffix?: string }) {
  return (
    <label className="flex items-center gap-1.5">
      {label && <span>{label}</span>}
      <Input value={value} onChange={(e) => onChange(e.target.value)} data-testid={testId} aria-label={name}
             inputMode="decimal" spellCheck={false} autoComplete="off" className="w-[72px]" />
      {suffix}
    </label>
  );
}
function Colors<T extends number[]>({ names, values, testId, onChange }: { names: string[]; values: T; testId: string; onChange(next: T): void }) {
  return (
    <div className="flex flex-wrap gap-2">
      {values.map((c, i) => (
        <input key={i} type="color" aria-label={names[i]} title={names[i]} data-testid={`${testId}-${i}`} value={colorToCss(c)} className="h-8 w-12 cursor-pointer rounded border p-0"
               style={{ borderColor: 'var(--hairline)' }}
               onChange={(e) => { const next = [...values] as T; next[i] = cssToColor(e.target.value); onChange(next); }} />
      ))}
    </div>
  );
}

/** The four groups. Apart from the Modal, so a test can render it (Base UI's portal renders nothing on the server). */
export function SysconfForm({ formId, draft: d, onChange, onSubmit }: { formId: string; draft: SysconfDraft; onChange(d: SysconfDraft): void; onSubmit(): void }) {
  const set = (o: Partial<SysconfDraft>) => onChange({ ...d, ...o });
  const fontId = useId(), mouseId = useId();
  return (
    <form id={formId} className="flex flex-col px-6 py-2" style={{ color: 'var(--ink)' }} onSubmit={(e) => { e.preventDefault(); onSubmit(); }}>
      <p className="py-2 text-[13px]" style={{ color: 'var(--faint)' }}>
        To use it, it must be in Devs on the disk you boot from. A full Workbench&apos;s saved prefs may replace these settings.
      </p>
      <Group title="Display">
        <Row label="System font" labelId={fontId} note={BOOT_ONLY}>
          <SegRadioGroup aria-labelledby={fontId} testId="sysconf-font" value={String(d.fontHeight) as '8' | '9'} onChange={(v) => set({ fontHeight: Number(v) as 8 | 9 })}
                         options={[{ value: '8', label: 'Topaz 8 (80 columns)' }, { value: '9', label: 'Topaz 9 (60)' }]} />
        </Row>
        <Row label="Workbench screen" note={BOOT_ONLY}>
          <label className="flex items-center gap-1.5">
            <input type="checkbox" checked={d.interlace} onChange={(e) => set({ interlace: e.target.checked })} data-testid="sysconf-interlace" /> Interlace
          </label>
        </Row>
        <Row label="Overscan position">
          <Num label="X" value={d.viewX} testId="sysconf-view-x" onChange={(viewX) => set({ viewX })} />
          <Num label="Y" value={d.viewY} testId="sysconf-view-y" onChange={(viewY) => set({ viewY })} />
        </Row>
        <Row label="Overscan size">
          <Num label="Rows" value={d.extraRows} testId="sysconf-rows" onChange={(extraRows) => set({ extraRows })} />
          <Num label="Columns" value={d.extraColumns} testId="sysconf-columns" onChange={(extraColumns) => set({ extraColumns })} />
        </Row>
      </Group>
      <Group title="Workbench colours">
        <Colors names={['Colour 0', 'Colour 1', 'Colour 2', 'Colour 3']} values={d.colors} testId="sysconf-color" onChange={(colors) => set({ colors })} />
      </Group>
      <Group title="Pointer" note={BOOT_ONLY}>
        <Colors names={['Pointer colour 1', 'Pointer colour 2', 'Pointer colour 3']} values={d.pointerColors} testId="sysconf-pointer-color" onChange={(pointerColors) => set({ pointerColors })} />
        <PointerEditor pointer={d.pointer} hotSpot={d.hotSpot} colors={d.pointerColors} onChange={(n) => set(n)} />
      </Group>
      <Group title="Keyboard and mouse">
        <Row label="Key repeat delay"><Num label="" name="Key repeat delay" value={d.keyDelay} testId="sysconf-key-delay" suffix="seconds" onChange={(keyDelay) => set({ keyDelay })} /></Row>
        <Row label="Key repeat speed"><Num label="" name="Key repeat speed" value={d.keySpeed} testId="sysconf-key-speed" suffix="seconds" onChange={(keySpeed) => set({ keySpeed })} /></Row>
        <Row label="Double-click time"><Num label="" name="Double-click time" value={d.doubleClick} testId="sysconf-double-click" suffix="seconds" onChange={(doubleClick) => set({ doubleClick })} /></Row>
        <Row label="Mouse speed" labelId={mouseId}>
          <SegRadioGroup aria-labelledby={mouseId} testId="sysconf-mouse" value={String(d.mouseTicks) as '1' | '2' | '4'} onChange={(v) => set({ mouseTicks: Number(v) as 1 | 2 | 4 })}
                         options={[{ value: '1', label: 'Fast' }, { value: '2', label: 'Medium' }, { value: '4', label: 'Slow' }]} />
          <label className="flex items-center gap-1.5">
            <input type="checkbox" checked={d.acceleration} onChange={(e) => set({ acceleration: e.target.checked })} data-testid="sysconf-accel" /> Acceleration
          </label>
        </Row>
      </Group>
    </form>
  );
}

type ClashChoice = 'replace' | 'keep-both' | 'skip';
export function SysconfFooter(p: {
  formId: string; busy: boolean; clash: boolean; settings: SysconfSettings | null; problem: string | null;
  onClash(c: ClashChoice, s: SysconfSettings): void; onBack(): void; onCancel(): void;
}) {
  const answer = (c: ClashChoice) => { if (p.settings) p.onClash(c, p.settings); };
  const off = p.busy || !p.settings;
  if (p.clash) {
    return (
      <div className="flex w-full flex-wrap items-center justify-end gap-2.5">
        <span role="alert" data-testid="files-sysconf-clash" className="mr-auto text-[13px]" style={{ color: 'var(--ink)' }}>{SYSCONF_NAME} is already here.</span>
        <Button variant="outline" onClick={p.onBack} disabled={p.busy} data-testid="files-sysconf-back">Back</Button>
        <Button variant="outline" onClick={() => answer('skip')} disabled={off} data-testid="files-sysconf-skip">Skip</Button>
        <Button variant="outline" onClick={() => answer('keep-both')} disabled={off} data-testid="files-sysconf-keep-both">Keep both</Button>
        <Button variant="destructive" onClick={() => answer('replace')} disabled={off} data-testid="files-sysconf-replace">Replace it</Button>
      </div>
    );
  }
  return (
    <div className="flex w-full flex-wrap items-center justify-end gap-2.5">
      {p.problem
        ? <span role="alert" data-testid="files-sysconf-problem" className="mr-auto text-[13px]" style={{ color: 'var(--danger-fg)' }}>{p.problem}</span>
        : <span className="mr-auto text-[12px]" style={{ color: 'var(--faint)' }}>{SYSCONF_SIZE} bytes</span>}
      <Button variant="outline" onClick={p.onCancel} disabled={p.busy}>Cancel</Button>
      <Button type="submit" form={p.formId} disabled={off} data-testid="files-sysconf-submit">{p.busy ? 'Creating…' : 'Create'}</Button>
    </div>
  );
}

/**
 * Create SysConf… (spec 2026-11-04): the settings Kickstart itself reads, starting at the Workbench disks' values each
 * time. What was entered stays in this component through a clash, so answering one loses nothing.
 */
export function SysconfDialog(p: {
  where: string; busy: boolean; clash: boolean;
  onCreate(s: SysconfSettings): void; onClash(c: ClashChoice, s: SysconfSettings): void; onBack(): void; onCancel(): void;
}) {
  const [draft, setDraft] = useState(() => draftOf(sysconfDefaults()));
  const formId = useId();
  const r = settingsOf(draft);
  const settings = 'settings' in r ? r.settings : null;
  return (
    <Modal open finalFocus={managerReturnsFocus} onOpenChange={(o) => { if (!o) p.onCancel(); }} width={620} testId="files-sysconf" closeTestId="files-sysconf-close"
           title="Create SysConf" subtitle={`${SYSCONF_NAME} in ${p.where}`} dismissible={!p.busy}
           footer={<SysconfFooter formId={formId} busy={p.busy} clash={p.clash} settings={settings} problem={'problem' in r ? r.problem : null}
                                  onClash={p.onClash} onBack={p.onBack} onCancel={p.onCancel} />}>
      <SysconfForm formId={formId} draft={draft} onChange={setDraft} onSubmit={() => { if (settings && !p.busy && !p.clash) p.onCreate(settings); }} />
    </Modal>
  );
}
