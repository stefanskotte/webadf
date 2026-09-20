import { describe, it, expect } from 'vitest';
import {
  isIdle, livePollDelay, LIVE_POLL_MS, LIVE_IDLE_POLL_MS, LIVE_IDLE_AFTER_MS,
} from './live-poll';

const NOW = 1_800_000_000_000;

describe('livePollDelay', () => {
  it('polls fast while the tab is being used', () => {
    expect(livePollDelay(NOW, NOW)).toBe(LIVE_POLL_MS);
    expect(livePollDelay(NOW, NOW - 1_000)).toBe(LIVE_POLL_MS);
    expect(livePollDelay(NOW, NOW - (LIVE_IDLE_AFTER_MS - 1))).toBe(LIVE_POLL_MS);
  });

  it('slows down once the tab has been idle for the threshold', () => {
    expect(livePollDelay(NOW, NOW - LIVE_IDLE_AFTER_MS)).toBe(LIVE_IDLE_POLL_MS);
    expect(livePollDelay(NOW, NOW - 3 * LIVE_IDLE_AFTER_MS)).toBe(LIVE_IDLE_POLL_MS);
  });

  it('treats a clock that jumped backwards as input just now, never as idleness', () => {
    // A laptop waking, or an NTP step: lastInputAt is "in the future".
    expect(isIdle(NOW, NOW + 60_000)).toBe(false);
    expect(livePollDelay(NOW, NOW + 60_000)).toBe(LIVE_POLL_MS);
  });

  it('is a ten-minute threshold and a thirty-second idle rate', () => {
    // The operator chose both numbers; pin them so a later edit is deliberate.
    expect(LIVE_IDLE_AFTER_MS).toBe(600_000);
    expect(LIVE_IDLE_POLL_MS).toBe(30_000);
    expect(LIVE_POLL_MS).toBe(3_000);
  });
});
