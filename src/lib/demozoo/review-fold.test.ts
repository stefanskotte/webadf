import { describe, it, expect } from 'vitest';
import { foldReviewQueue, type QueueSuggestionRow } from './review-fold';

const none = new Map<string, ReadonlySet<number>>();
const noAuto = new Map<string, number[]>();

// Most rows in this file don't care about disk identity -- one fixed
// (diskNo, filename) pair keeps every unrelated case's row literals short.
const d1 = { diskNo: 1, filename: 'game.adf' };

describe('foldReviewQueue — which games have an unresolved Demozoo suggestion', () => {
  it('puts a single-candidate game ahead of a multi-candidate one, alphabetical order notwithstanding', () => {
    const rows: QueueSuggestionRow[] = [
      { gameId: 'zeta', gameTitle: 'Zeta', productionId: 1, source: 'filename', ...d1 },
      { gameId: 'zeta', gameTitle: 'Zeta', productionId: 2, source: 'filename', ...d1 },
      { gameId: 'alpha', gameTitle: 'Alpha', productionId: 3, source: 'filename', ...d1 },
    ];
    const groups = foldReviewQueue(rows, noAuto, none);
    expect(groups.map((g) => g.gameId)).toEqual(['alpha', 'zeta']);
  });

  it('dedupes sources for the same production within a game', () => {
    const rows: QueueSuggestionRow[] = [
      { gameId: 'g1', gameTitle: 'Game', productionId: 1, source: 'tosec_title', ...d1 },
      { gameId: 'g1', gameTitle: 'Game', productionId: 1, source: 'tosec_title', ...d1 },
      { gameId: 'g1', gameTitle: 'Game', productionId: 1, source: 'volume_name', ...d1 },
    ];
    const groups = foldReviewQueue(rows, noAuto, none);
    expect(groups).toEqual([
      { gameId: 'g1', gameTitle: 'Game', entries: [{ productionId: 1, sources: ['tosec_title', 'volume_name'], disks: [d1] }] },
    ]);
  });

  it('drops a suggestion this game has already dismissed', () => {
    const rows: QueueSuggestionRow[] = [
      { gameId: 'g1', gameTitle: 'Game', productionId: 1, source: 'filename', ...d1 },
      { gameId: 'g1', gameTitle: 'Game', productionId: 2, source: 'filename', ...d1 },
    ];
    const dismissedOf = new Map<string, ReadonlySet<number>>([['g1', new Set([1])]]);
    const groups = foldReviewQueue(rows, noAuto, dismissedOf);
    expect(groups).toEqual([{ gameId: 'g1', gameTitle: 'Game', entries: [{ productionId: 2, sources: ['filename'], disks: [d1] }] }]);
  });

  it('drops the whole game once its disks agree on a non-dismissed automatic link', () => {
    const rows: QueueSuggestionRow[] = [
      { gameId: 'g1', gameTitle: 'Game', productionId: 5, source: 'filename', ...d1 },
    ];
    const autoOf = new Map<string, number[]>([['g1', [9]]]);
    const groups = foldReviewQueue(rows, autoOf, none);
    expect(groups).toEqual([]);
  });

  it('an automatic link the game has dismissed does not suppress its other suggestions', () => {
    const rows: QueueSuggestionRow[] = [
      { gameId: 'g1', gameTitle: 'Game', productionId: 5, source: 'filename', ...d1 },
    ];
    const autoOf = new Map<string, number[]>([['g1', [9]]]);
    const dismissedOf = new Map<string, ReadonlySet<number>>([['g1', new Set([9])]]);
    const groups = foldReviewQueue(rows, autoOf, dismissedOf);
    expect(groups).toEqual([{ gameId: 'g1', gameTitle: 'Game', entries: [{ productionId: 5, sources: ['filename'], disks: [d1] }] }]);
  });

  it('orders equal titles by game id', () => {
    const rows: QueueSuggestionRow[] = [
      { gameId: 'b', gameTitle: 'Same Title', productionId: 1, source: 'filename', ...d1 },
      { gameId: 'a', gameTitle: 'Same Title', productionId: 2, source: 'filename', ...d1 },
    ];
    const groups = foldReviewQueue(rows, noAuto, none);
    expect(groups.map((g) => g.gameId)).toEqual(['a', 'b']);
  });

  it('sorts a game\'s own entries by production id', () => {
    const rows: QueueSuggestionRow[] = [
      { gameId: 'g1', gameTitle: 'Game', productionId: 30, source: 'filename', ...d1 },
      { gameId: 'g1', gameTitle: 'Game', productionId: 10, source: 'filename', ...d1 },
      { gameId: 'g1', gameTitle: 'Game', productionId: 20, source: 'filename', ...d1 },
    ];
    const groups = foldReviewQueue(rows, noAuto, none);
    expect(groups[0].entries.map((e) => e.productionId)).toEqual([10, 20, 30]);
  });

  it('R18: two disks of one game suggesting the same production fold into one entry, both disks, sorted', () => {
    const rows: QueueSuggestionRow[] = [
      { gameId: 'g1', gameTitle: 'Game', productionId: 1, source: 'filename', diskNo: 2, filename: 'disk2.adf' },
      { gameId: 'g1', gameTitle: 'Game', productionId: 1, source: 'filename', diskNo: 1, filename: 'disk1.adf' },
    ];
    const groups = foldReviewQueue(rows, noAuto, none);
    expect(groups).toEqual([{
      gameId: 'g1', gameTitle: 'Game',
      entries: [{
        productionId: 1, sources: ['filename'],
        disks: [{ diskNo: 1, filename: 'disk1.adf' }, { diskNo: 2, filename: 'disk2.adf' }],
      }],
    }]);
  });
});
