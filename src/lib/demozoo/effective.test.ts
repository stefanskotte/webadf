import { describe, it, expect } from 'vitest';
import { effectiveLink, productionToDismissAfterClear, agreesOnAutomaticLink } from './effective';

const none = new Set<number>();
describe('effectiveLink — which Demozoo production a game shows', () => {
  it('an org confirmation wins over a global automatic link', () => {
    expect(effectiveLink({ demozooProductionId: 5, demozooLinkSource: 'confirmed' }, [9], none))
      .toEqual({ productionId: 5, source: 'confirmed' });
  });
  it('otherwise the automatic link from the game\'s own disks', () => {
    expect(effectiveLink({ demozooProductionId: null, demozooLinkSource: null }, [9], none))
      .toEqual({ productionId: 9, source: 'automatic' });
  });
  it('an org dismissal hides an automatic link for that game only', () => {
    expect(effectiveLink({ demozooProductionId: null, demozooLinkSource: null }, [9], new Set([9]))).toBeNull();
  });
  it('disks disagreeing on the automatic link show nothing rather than guess', () => {
    expect(effectiveLink({ demozooProductionId: null, demozooLinkSource: null }, [9, 11], none)).toBeNull();
  });
});

describe('productionToDismissAfterClear — what Unlink must hide once a confirmation is gone (R11)', () => {
  it('a confirmation equal to the automatic link: dismiss it so it cannot reassert', () => {
    expect(productionToDismissAfterClear([5], none)).toBe(5);
  });
  it('a confirmation plus a different automatic link: dismiss the automatic one', () => {
    expect(productionToDismissAfterClear([9], none)).toBe(9);
  });
  it('no confirmation, disagreeing automatic ids: nothing to dismiss', () => {
    expect(productionToDismissAfterClear([9, 11], none)).toBeNull();
  });
  it('already dismissed: nothing new to dismiss', () => {
    expect(productionToDismissAfterClear([9], new Set([9]))).toBeNull();
  });
});

describe('agreesOnAutomaticLink — applyAutomaticLink\'s per-game disagreement guard (R11)', () => {
  it('agrees when it is the only (non-dismissed) applied id', () => {
    expect(agreesOnAutomaticLink([9], none, 9)).toBe(true);
  });
  it('disagrees when another disk applied a different production', () => {
    expect(agreesOnAutomaticLink([9, 11], none, 9)).toBe(false);
  });
  it('a dismissed id on another disk does not count as disagreement', () => {
    expect(agreesOnAutomaticLink([9, 11], new Set([11]), 9)).toBe(true);
  });
});
