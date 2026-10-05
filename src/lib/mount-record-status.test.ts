import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';

// recordStatus's firmware-completion rule (final review I2): a board in its
// TBYB trial runs the new version but has not confirmed it -- it may still
// revert. It says so with firmwareUpdateState "applying", and completion must
// wait for the confirmed boot. The fake db records the ONE update's patch;
// the completion clear is a CASE expression in that patch (compare-and-clear,
// no read-then-write), so "completion considered" == the CASE is present.

let patches: Record<string, unknown>[] = [];
const fakeDb = {
  update: () => ({
    set: (patch: Record<string, unknown>) => {
      patches.push(patch);
      return { where: async () => undefined };
    },
  }),
  select: () => { throw new Error('recordStatus must not read in these cases'); },
};
vi.mock('@/db', () => ({ getDb: () => fakeDb }));

const { recordStatus } = await import('./mount');
const dialect = new PgDialect();
const render = (v: unknown) => dialect.sqlToQuery(v as SQL).sql;

beforeEach(() => { patches = []; });

const base = { mountedSha256: null, firmwareVersion: '1.1.3+gabc', updateProtocol: 1 };

describe('recordStatus firmware completion', () => {
  it('does NOT complete on a trial report (version == desired, state applying)', async () => {
    await recordStatus('dev-1', { ...base, firmwareUpdateState: 'applying', firmwareUpdateError: null });
    expect(patches).toHaveLength(1);
    const p = patches[0];
    expect(p.desiredFirmwareVersion).toBeUndefined();
    expect(p.desiredFirmwareSetAt).toBeUndefined();
    expect(p.desiredFirmwareSetByUserId).toBeUndefined();
    // The trial's own progress still lands, plainly.
    expect(p.firmwareUpdateState).toBe('applying');
    expect(p.firmwareVersion).toBe('1.1.3+gabc');
  });

  it('completes on the confirmed boot (state null), in the single UPDATE', async () => {
    await recordStatus('dev-1', { ...base, firmwareUpdateState: null, firmwareUpdateError: null });
    expect(patches).toHaveLength(1);
    const p = patches[0];
    expect(render(p.desiredFirmwareVersion)).toMatch(/case when .*desired_firmware_version.* = \$1 then null/);
    expect(render(p.firmwareUpdateState)).toMatch(/^case when/);
  });

  it('completes when an older board omits the state field entirely', async () => {
    await recordStatus('dev-1', { ...base });
    expect(render(patches[0].desiredFirmwareVersion)).toMatch(/^case when/);
  });

  it('still completes on a failed report whose version matches (not applying)', async () => {
    await recordStatus('dev-1', { ...base, firmwareUpdateState: 'failed', firmwareUpdateError: 'x' });
    expect(render(patches[0].desiredFirmwareVersion)).toMatch(/^case when/);
  });
});

// trackMaxBytes belongs to the firmware build (psram_image.h TRACK_MAX_BYTES),
// so it does NOT follow the absent-leaves-it-alone rule: a report that names
// a firmware version without it comes from a build too old to know the field
// (a board that rolled back after a failed trial boot) and must fall back to
// the legacy limit, or the mount gate would send it tracks it rejects.
describe('recordStatus trackMaxBytes', () => {
  it('stores the limit a board reports', async () => {
    await recordStatus('dev-1', { ...base, trackMaxBytes: 14_336 });
    expect(patches[0].trackMaxBytes).toBe(14_336);
  });

  it('resets to null (legacy) when a report names its firmware but carries no limit', async () => {
    await recordStatus('dev-1', { ...base });
    expect('trackMaxBytes' in patches[0]).toBe(true);
    expect(patches[0].trackMaxBytes).toBeNull();
  });

  it('leaves the limit alone when a report names no firmware at all', async () => {
    await recordStatus('dev-1', { mountedSha256: null });
    expect('trackMaxBytes' in patches[0]).toBe(false);
  });
});

// playsHd belongs to the firmware BUILD (the drive-ID responder, WF_DRIVE_ID),
// exactly like trackMaxBytes: a report that names its firmware without it is
// a build that cannot answer HD -- older, built with the responder off, or a
// board that reverted a trial boot -- and must stop being sent HD disks.
describe('recordStatus playsHd', () => {
  it('stores what a board reports', async () => {
    await recordStatus('dev-1', { ...base, playsHd: true });
    expect(patches[0].playsHd).toBe(true);
  });

  it('drops to false when a report names its firmware but says nothing about HD (a rollback)', async () => {
    await recordStatus('dev-1', { ...base });
    expect('playsHd' in patches[0]).toBe(true);
    expect(patches[0].playsHd).toBe(false);
  });

  it('leaves the column alone when a report names no firmware at all', async () => {
    await recordStatus('dev-1', { mountedSha256: null });
    expect('playsHd' in patches[0]).toBe(false);
  });
});

// preload (multi-disk spec §3.5, plan ruling R3): what the board's idle slot
// holds. Build-bound like trackMaxBytes/playsHd above -- a report naming its
// firmware but silent on preload comes from a build without the field, and
// must not keep a newer build's claim.
describe('recordStatus preload', () => {
  it('an object stores both columns', async () => {
    await recordStatus('dev-1', { ...base, preload: { sha256: 'b'.repeat(64), state: 'ready' } });
    expect(patches[0].preloadSha256).toBe('b'.repeat(64));
    expect(patches[0].preloadState).toBe('ready');
  });

  it('null stores sha NULL and state "none"', async () => {
    await recordStatus('dev-1', { ...base, preload: null });
    expect(patches[0].preloadSha256).toBeNull();
    expect(patches[0].preloadState).toBe('none');
  });

  it('absent with firmwareVersion present sets both NULL (a build that does not know the field)', async () => {
    await recordStatus('dev-1', { ...base });
    expect('preloadSha256' in patches[0]).toBe(true);
    expect('preloadState' in patches[0]).toBe(true);
    expect(patches[0].preloadSha256).toBeNull();
    expect(patches[0].preloadState).toBeNull();
  });

  it('absent without firmwareVersion leaves both columns untouched', async () => {
    await recordStatus('dev-1', { mountedSha256: null });
    expect('preloadSha256' in patches[0]).toBe(false);
    expect('preloadState' in patches[0]).toBe(false);
  });
});

// OLED layouts spec §7: the capability is build-bound like playsHd; the ack is
// stored as display_applied_version by plain assignment (it can go DOWN when a
// re-paired board resets it), and the reason rides alongside.
describe('recordStatus display layouts', () => {
  it('stores the capability, the ack as displayAppliedVersion, and the error', async () => {
    await recordStatus('dev-1', { ...base, displayLayouts: true, displayVersion: 4, displayError: 'bad' });
    const p = patches[0];
    expect(p.displayLayouts).toBe(true);
    expect(p.displayAppliedVersion).toBe(4);
    expect(p.displayError).toBe('bad');
  });

  it('a report naming its firmware but silent on displayLayouts sets it false', async () => {
    await recordStatus('dev-1', { ...base });
    expect('displayLayouts' in patches[0]).toBe(true);
    expect(patches[0].displayLayouts).toBe(false);
    expect('displayAppliedVersion' in patches[0]).toBe(false);
    expect('displayError' in patches[0]).toBe(false);
  });

  it('a report with no firmwareVersion and no display fields leaves all three alone', async () => {
    await recordStatus('dev-1', { mountedSha256: null });
    expect('displayLayouts' in patches[0]).toBe(false);
  });

  it('stores an ack lower than before as-is (no greatest())', async () => {
    await recordStatus('dev-1', { ...base, displayLayouts: true, displayVersion: 0, displayError: null });
    expect(patches[0].displayAppliedVersion).toBe(0);
    expect(patches[0].displayError).toBeNull();
  });
});
