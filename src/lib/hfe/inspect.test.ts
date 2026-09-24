import { describe, it, expect } from 'vitest';
import { inspectHfe, describeInspection } from './inspect';
import { HFE_V3_REFUSAL, NOT_AMIGA, WEAK_BIT_NOTICE } from './messages';
import { fixture, zeroSide, setTrackLength } from './__fixtures__/load';

describe('inspectHfe', () => {
  it('accepts the clean fixture: extractable, weak-bit notice', () => {
    const r = inspectHfe(fixture('clean'));
    expect(r).toEqual({ ok: true, cylinders: 80, notices: [WEAK_BIT_NOTICE], extractable: true, extractReason: null });
  });

  it('accepts a damaged disk as play-only and says which track', () => {
    const r = inspectHfe(zeroSide(fixture('clean'), 40, 1, 2000, 6000));
    if (!r.ok) throw new Error(r.reason);
    expect(r.extractable).toBe(false);
    expect(r.extractReason).toMatch(/^Track 81 /);
    expect(describeInspection(r)).toContain('play only');
  });

  it('refuses v3, a PC disk, and a blank track 0 with the spec wording', () => {
    expect(inspectHfe(fixture('v3'))).toEqual({ ok: false, reason: HFE_V3_REFUSAL });
    expect(inspectHfe(fixture('pc'))).toEqual({ ok: false, reason: NOT_AMIGA });
    expect(inspectHfe(zeroSide(fixture('clean'), 0, 0, 0, 12_668))).toEqual({ ok: false, reason: NOT_AMIGA });
  });

  it('refuses an over-long served track at upload', () => {
    // 2 x 13,400 bytes: the file is long enough (cylinders are 50 blocks apart), the track is not playable.
    const r = inspectHfe(setTrackLength(fixture('clean'), 3, 26_800));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/^Cylinder 3 side 0 is 107200 bits/);
  });

  it('never throws on garbage', () => {
    expect(inspectHfe(new Uint8Array(0)).ok).toBe(false);
    expect(inspectHfe(new Uint8Array(3000).fill(0xff)).ok).toBe(false);
  });
});
