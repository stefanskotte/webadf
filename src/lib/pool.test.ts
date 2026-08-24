import { describe, it, expect } from 'vitest';
import { mapLimit } from './pool';

describe('mapLimit', () => {
  it('preserves input order regardless of completion order', async () => {
    const out = await mapLimit([5, 1, 4, 2, 3], 3, async (n) => {
      await new Promise((r) => setTimeout(r, n));
      return n * 10;
    });
    expect(out).toEqual([50, 10, 40, 20, 30]);
  });

  // The point of the whole module: 500 items must never be 500 in flight.
  it('never exceeds the limit in flight', async () => {
    let inFlight = 0;
    let peak = 0;
    await mapLimit(Array.from({ length: 500 }, (_, i) => i), 6, async () => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 1));
      inFlight--;
    });
    expect(peak).toBe(6);
  });

  it('runs every item exactly once', async () => {
    const seen: number[] = [];
    await mapLimit([1, 2, 3, 4, 5, 6, 7], 3, async (n) => { seen.push(n); });
    expect(seen.sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });

  it('handles an empty input without hanging', async () => {
    await expect(mapLimit([], 4, async () => 1)).resolves.toEqual([]);
  });

  it('propagates a rejection', async () => {
    await expect(
      mapLimit([1, 2, 3], 2, async (n) => { if (n === 2) throw new Error('boom'); return n; }),
    ).rejects.toThrow('boom');
  });

  it('rejects a nonsensical limit rather than silently hanging', async () => {
    await expect(mapLimit([1], 0, async (n) => n)).rejects.toThrow(/limit/);
  });
});
