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
