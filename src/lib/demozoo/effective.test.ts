import { describe, it, expect } from 'vitest';
import { effectiveLink } from './effective';

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
