import { describe, expect, it, vi } from 'vitest';
import { nowMs } from './clock';

describe('nowMs', () => {
  it('reads the wall clock at call time', () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-10-18T12:00:00Z'));
      expect(nowMs()).toBe(Date.parse('2026-10-18T12:00:00Z'));
      vi.setSystemTime(new Date('2026-10-18T12:00:05Z'));
      expect(nowMs()).toBe(Date.parse('2026-10-18T12:00:05Z'));
    } finally {
      vi.useRealTimers();
    }
  });
});
