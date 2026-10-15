import { describe, it, expect } from 'vitest';
import { parseCron, nextRun } from './cron';
import { config } from '../../vercel';

describe('cron', () => {
  it('parses every schedule vercel.ts declares', () => {
    expect(config.crons?.length).toBeGreaterThan(0);
    for (const c of config.crons ?? []) expect(() => parseCron(c.schedule)).not.toThrow();
  });
  it('nightly 03:00', () => {
    expect(nextRun(parseCron('0 3 * * *'), new Date('2026-10-15T02:59:30Z')).toISOString()).toBe('2026-10-15T03:00:00.000Z');
    expect(nextRun(parseCron('0 3 * * *'), new Date('2026-10-15T03:00:00Z')).toISOString()).toBe('2026-10-16T03:00:00.000Z');
  });
  it('weekly Sunday 04:00', () => {
    // 2026-10-15 is a Thursday
    expect(nextRun(parseCron('0 4 * * 0'), new Date('2026-10-15T12:00:00Z')).toISOString()).toBe('2026-10-18T04:00:00.000Z');
  });
  it('daily 01:30', () => {
    expect(nextRun(parseCron('30 1 * * *'), new Date('2026-10-15T01:31:00Z')).toISOString()).toBe('2026-10-16T01:30:00.000Z');
  });
  it('refuses what it cannot honour', () => {
    expect(() => parseCron('*/5 * * * *')).toThrow(/unsupported cron field/);
    expect(() => parseCron('0 3 * *')).toThrow(/5 fields/);
  });
});
