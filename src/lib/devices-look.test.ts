import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ratio } from '@/lib/contrast.test-util';
import type { DeviceListItem } from '@/lib/queries';
import { driveBoxText, firmwareCardText, firmwareCellText, needsGetStarted, networkCell, shortVersion, signalCell, statusPill } from './devices-look';

// Spec docs/superpowers/specs/2026-10-24-phase-c2-devices-design.md §2.1, §2.2, §4.2, §12.
type D = Pick<DeviceListItem, 'mountedGame' | 'mountedDiskNo' | 'mountedSha256' | 'desiredGame' | 'desiredDiskNo'
  | 'desiredDiskCount' | 'desiredSha256'>;
const base: D = {
  mountedGame: null, mountedDiskNo: null, mountedSha256: null, desiredGame: null, desiredDiskNo: null,
  desiredDiskCount: 0, desiredSha256: null,
};
const dev = (o: Partial<D>) => ({ ...base, ...o }) as DeviceListItem;

describe('firmwareCellText', () => {
  it('drops a leading "fw "', () => {
    expect(firmwareCellText('fw 1.21.0 · up to date')).toBe('1.21.0 · up to date');
    expect(firmwareCellText('fw unknown')).toBe('unknown');
  });
  it('passes update labels through', () => {
    expect(firmwareCellText('Updating to 1.21.1')).toBe('Updating to 1.21.1');
    expect(firmwareCellText('Update failed: x')).toBe('Update failed: x');
  });
});

describe('firmwareCardText (2026-11-12: firmware in words)', () => {
  it('drops the build suffix and capitalises each part', () => {
    expect(firmwareCardText('fw 1.24.2+ged0ecc5e · up to date')).toBe('1.24.2 · Up to date');
    expect(firmwareCardText('fw 1.21.1+ga5424b4 · 2 releases behind')).toBe('1.21.1 · 2 releases behind');
    expect(firmwareCardText('fw 1.21.1-dirty+ga5424b4 · unrecognised build')).toBe('1.21.1-dirty · Unrecognised build');
    expect(firmwareCardText('fw 1.21.1 · no releases published')).toBe('1.21.1 · No releases published');
    expect(firmwareCardText('fw unknown')).toBe('Unknown');
  });
  it('words an update in flight the same way', () => {
    expect(firmwareCardText('downloading 1.24.2+ged0ecc5e')).toBe('Downloading 1.24.2');
    expect(firmwareCardText('applying 1.24.2+g1 — do not power off')).toBe('Applying 1.24.2 — do not power off');
    expect(firmwareCardText('update queued — waiting for eject')).toBe('Update queued — waiting for eject');
    expect(firmwareCardText('update failed — trial timed out')).toBe('Update failed — trial timed out');
  });
  it('shortVersion keeps the semver', () => {
    expect(shortVersion('1.24.2+ged0ecc5e')).toBe('1.24.2');
    expect(shortVersion('1.24.2')).toBe('1.24.2');
  });
});

describe('networkCell and needsGetStarted (2026-11-12)', () => {
  it('names both network values in words', () => {
    expect(networkCell(true)).toBe('Wi-Fi');
    expect(networkCell(false)).toBe('Not connected');
  });
  it('Get started until a disk is held, wanted, or was ever ejected', () => {
    const none = { desiredSha256: null, mountedSha256: null, lastDiskId: null };
    expect(needsGetStarted(none)).toBe(true);
    expect(needsGetStarted({ ...none, desiredSha256: 'a' })).toBe(false);
    expect(needsGetStarted({ ...none, mountedSha256: 'a' })).toBe(false);
    expect(needsGetStarted({ ...none, lastDiskId: 'd' })).toBe(false);
  });
});

describe('driveBoxText (spec §4.2)', () => {
  it('converged: the mounted disk, "disk n", and " of count" only when count > 0', () => {
    expect(driveBoxText(dev({ mountedGame: 'Turrican', mountedDiskNo: 2, desiredDiskCount: 3 }), 'converged')).toEqual({
      label: 'In the drive', labelTone: 'muted-2', title: 'Turrican', meta: 'disk 2 of 3',
    });
    expect(driveBoxText(dev({ mountedGame: 'Turrican', mountedDiskNo: 2, desiredDiskCount: 0 }), 'converged').meta)
      .toBe('disk 2');
    expect(driveBoxText(dev({ desiredDiskCount: null }), 'converged'))
      .toMatchObject({ title: 'Unknown', meta: 'disk ?' });
  });
  it('mounting: the desired disk; "currently holding" only while one is held', () => {
    const t = driveBoxText(dev({ desiredSha256: 'a', desiredGame: 'Lemmings', desiredDiskNo: 1 }), 'pending');
    expect(t).toEqual({ label: 'Mounting…', labelTone: 'muted', title: 'Lemmings', meta: 'disk 1' });
    expect(driveBoxText(dev({
      desiredSha256: 'a', desiredGame: 'Lemmings', desiredDiskNo: 1, mountedSha256: 'b', mountedGame: 'Turrican',
      mountedDiskNo: 2,
    }), 'pending').meta).toBe('disk 1 · currently holding Turrican disk 2');
    expect(driveBoxText(dev({ desiredSha256: 'a', mountedSha256: 'b' }), 'pending').meta)
      .toBe('disk ? · currently holding a disk disk ?');
    expect(driveBoxText(dev({ desiredSha256: 'a' }), 'pending').title).toBe('Unknown');
  });
  it('ejecting: the mounted disk on its way out', () => {
    expect(driveBoxText(dev({ mountedSha256: 'b', mountedGame: 'Turrican', mountedDiskNo: 2 }), 'pending')).toEqual({
      label: 'Ejecting…', labelTone: 'muted', title: 'Turrican', meta: 'Removing disk 2',
    });
    expect(driveBoxText(dev({ mountedSha256: 'b' }), 'pending'))
      .toMatchObject({ title: 'a disk', meta: 'Removing disk ?' });
  });
  it('stale: requested, amber', () => {
    expect(driveBoxText(dev({ desiredGame: 'Lemmings', desiredDiskNo: 3 }), 'stale')).toEqual({
      label: 'Requested', labelTone: 'amber', title: 'Lemmings', meta: 'disk 3',
    });
    expect(driveBoxText(dev({}), 'stale')).toMatchObject({ title: 'Unknown', meta: 'disk ?' });
  });
  it('empty: No disk', () => {
    expect(driveBoxText(dev({}), 'empty')).toEqual({
      label: 'In the drive', labelTone: 'muted-2', title: 'No disk', meta: 'Pick a game in the Library and press Mount.',
    });
  });
});

describe('statusPill (spec §2.1)', () => {
  it('online', () => {
    expect(statusPill(true)).toEqual({
      label: 'Online', bg: 'var(--success-bg)', fg: 'var(--success-fg)', dot: 'var(--online-dot)',
      halo: 'rgb(63 191 85 / .2)',
    });
  });
  it('offline', () => {
    expect(statusPill(false)).toEqual({
      label: 'Offline', bg: 'var(--danger-bg)', fg: 'var(--danger-fg)', dot: 'var(--danger-fg)',
      halo: 'rgb(179 52 31 / .2)',
    });
  });
});

describe('signalCell (spec §2.1, in words 2026-11-12)', () => {
  it.each([
    [-44, 3, 'Good'], [-60, 3, 'Good'], [-65, 2, 'Fair'], [-70, 2, 'Fair'], [-75, 1, 'Weak'], [-90, 0, 'Weak'],
  ])('%i dBm lights %i and reads %s, with the reading as the title', (rssi, lit, text) => {
    expect(signalCell(rssi, true)).toEqual({ lit, text, title: `${rssi} dBm` });
  });
  it('unreported or offline lights none and reads a dash', () => {
    expect(signalCell(null, true)).toEqual({ lit: 0, text: '—', title: null });
    expect(signalCell(-44, false)).toEqual({ lit: 0, text: '—', title: null });
  });
});

// Spec §12: the pairs that involve tokens in globals.css (the rest are literal-colour-free token pairs).
const css = readFileSync(join(process.cwd(), 'src/app/globals.css'), 'utf8');
function tok(name: string): string {
  const all = [...css.matchAll(new RegExp(`(${name}):\\s*(#[0-9a-fA-F]{6})\\b`, 'g'))];
  if (all.length === 0) throw new Error(`${name} is not set as a #rrggbb hex in globals.css`);
  return all[all.length - 1][2].toUpperCase();
}
describe('Devices tokens and contrast (spec §12)', () => {
  it('--fw-line and --modal-foot are the specced values', () => {
    expect(tok('--fw-line')).toBe('#F1D3A4');
    expect(tok('--modal-foot')).toBe('#FBF8F1');
  });
  it.each([
    ['--muted-2', '--surface-2', 5.08], ['--muted-2', '--ground', 4.94], ['--muted', '--danger-bg', 5.99],
    ['--ink', '--danger-bg', 12.8], ['--success-fg', '--success-bg', 5.57], ['--danger-fg', '--danger-bg', 4.9],
    ['--warning-fg', '--warning-bg', 6.38], ['--muted', '--track', 6.2], ['--muted-2', '--modal-foot', 5.35],
    ['--surface', '--ink', 15.79],
  ])('%s on %s is about %d and clears 4.5', (fg, bg, expected) => {
    const r = ratio(tok(fg), tok(bg));
    expect(r).toBeGreaterThanOrEqual(4.5);
    expect(Math.abs(r - expected)).toBeLessThan(0.06);
  });
});
