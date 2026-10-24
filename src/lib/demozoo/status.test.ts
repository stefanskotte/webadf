import { describe, it, expect } from 'vitest';
import { demozooStatusText } from './status';

const NOW = Date.parse('2026-10-24T12:00:00Z');
const ago = (ms: number) => new Date(NOW - ms);
const H = 3_600_000;
const D = 24 * H;

describe('demozooStatusText', () => {
  it('applied: names when, how much, and when it last checked', () => {
    expect(demozooStatusText({
      step: 'applied', appliedAt: ago(2 * D), lastAttemptAt: ago(3 * H), fetchedAt: ago(2 * D),
      productionsWritten: 78447, screenshotsWritten: 1200,
    }, NOW)).toBe('Demozoo: applied 2d ago · 78447 productions · 1200 screenshots · last checked 3h ago');
  });

  it('applied with zero counts still says so', () => {
    expect(demozooStatusText({
      step: 'applied', appliedAt: ago(H), lastAttemptAt: ago(H), fetchedAt: ago(H),
      productionsWritten: 0, screenshotsWritten: 0,
    }, NOW)).toBe('Demozoo: applied 1h ago · 0 productions · 0 screenshots · last checked 1h ago');
  });

  it.each(['fetched', 'extracted'])('step %s: fetched, not applied yet', (step) => {
    expect(demozooStatusText({
      step, appliedAt: null, lastAttemptAt: ago(D), fetchedAt: ago(5 * H),
      productionsWritten: 0, screenshotsWritten: 0,
    }, NOW)).toBe('Demozoo: fetched 5h ago, not applied yet');
  });

  it('no row: never fetched', () => {
    expect(demozooStatusText(null, NOW)).toBe('Demozoo: never fetched');
  });

  it('read failed: unreadable', () => {
    expect(demozooStatusText('unreadable', NOW)).toBe('Demozoo: unreadable');
  });
});
