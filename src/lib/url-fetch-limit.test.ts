import { describe, it, expect } from 'vitest';
import { SlidingWindowLimiter, takeUrlFetch, URL_FETCH_RATE } from './url-fetch-limit';

describe('takeUrlFetch', () => {
  it(`allows ${URL_FETCH_RATE.perUserPerMinute} a minute per user, then says how long to wait`, () => {
    let t = 1_000_000;
    const l = new SlidingWindowLimiter(() => t);
    for (let i = 0; i < URL_FETCH_RATE.perUserPerMinute; i++) expect(takeUrlFetch('u1', 'o1', l).ok).toBe(true);
    const refused = takeUrlFetch('u1', 'o1', l);
    expect(refused.ok).toBe(false);
    expect(!refused.ok && refused.retryAfterMs).toBe(60_000);
    // Another user in the same org is not affected by u1's minute.
    expect(takeUrlFetch('u2', 'o1', l).ok).toBe(true);
    t += 60_000;
    expect(takeUrlFetch('u1', 'o1', l).ok).toBe(true);
  });

  it('caps a user per hour and an org per hour', () => {
    let t = 0;
    const l = new SlidingWindowLimiter(() => t);
    let ok = 0;
    for (let i = 0; i < 200; i++) { if (takeUrlFetch('u1', 'o1', l).ok) ok++; t += 11_000; }
    expect(ok).toBe(URL_FETCH_RATE.perUserPerHour);

    const l2 = new SlidingWindowLimiter(() => 0);
    let orgOk = 0;
    for (let u = 0; u < 100; u++) for (let i = 0; i < 6; i++) if (takeUrlFetch(`u${u}`, 'o1', l2).ok) orgOk++;
    expect(orgOk).toBe(URL_FETCH_RATE.perOrgPerHour);
  });

  it('a refused attempt is not counted', () => {
    const l = new SlidingWindowLimiter(() => 0);
    for (let i = 0; i < 10; i++) takeUrlFetch('u1', 'o1', l);
    // u1 took only 6; the org has room for 114 more from others.
    let others = 0;
    for (let u = 0; u < 30; u++) for (let i = 0; i < 6; i++) if (takeUrlFetch(`x${u}`, 'o1', l).ok) others++;
    expect(others).toBe(URL_FETCH_RATE.perOrgPerHour - URL_FETCH_RATE.perUserPerMinute);
  });
});
