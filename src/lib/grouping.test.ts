import { describe, it, expect } from 'vitest';
import { groupDisks } from './grouping';

const d = (filename: string, sha256: string) => ({ filename, sha256, sizeBytes: 901120 });

describe('groupDisks', () => {
  it('groups a multi-disk set into one game, ordered by disk number', () => {
    const games = groupDisks([
      d('Project-X (1992)(Team 17)(Disk 2 of 4).adf', 'b'),
      d('Project-X (1992)(Team 17)(Disk 1 of 4).adf', 'a'),
    ]);
    expect(games).toHaveLength(1);
    expect(games[0].title).toBe('Project-X');
    expect(games[0].disks.map((x) => x.diskNo)).toEqual([1, 2]);
    expect(games[0].disks[0].sha256).toBe('a');
  });

  it('marks only disk 1 as boot', () => {
    const g = groupDisks([
      d('X (1990)(Y)(Disk 1 of 2).adf', 'a'),
      d('X (1990)(Y)(Disk 2 of 2).adf', 'b'),
    ])[0];
    expect(g.disks.find((x) => x.diskNo === 1)!.isBoot).toBe(true);
    expect(g.disks.find((x) => x.diskNo === 2)!.isBoot).toBe(false);
  });

  it('treats a single disk as a one-disk game with disk number 1', () => {
    const g = groupDisks([d('Marble Slide (1990)(Handel, Peter)(PD).adf', 'a')])[0];
    expect(g.disks).toHaveLength(1);
    expect(g.disks[0].diskNo).toBe(1);
    expect(g.disks[0].isBoot).toBe(true);
  });

  it('keeps different titles apart', () => {
    expect(groupDisks([
      d('A (1990)(P).adf', 'a'),
      d('B (1991)(P).adf', 'b'),
    ])).toHaveLength(2);
  });

  it('does not merge same-titled releases from different years', () => {
    const games = groupDisks([
      d('Elite (1988)(Firebird).adf', 'a'),
      d('Elite (1991)(Hybrid).adf', 'b'),
    ]);
    expect(games).toHaveLength(2);
  });

  it('deduplicates identical hashes within one set', () => {
    const g = groupDisks([
      d('X (1990)(Y)(Disk 1 of 2).adf', 'a'),
      d('X (1990)(Y)(Disk 1 of 2).adf', 'a'),
    ])[0];
    expect(g.disks).toHaveLength(1);
  });

  it('returns games sorted by sortTitle', () => {
    const games = groupDisks([d('Zool (1992)(Gremlin).adf', 'z'), d('Alien (1993)(X).adf', 'a')]);
    expect(games.map((g) => g.title)).toEqual(['Alien', 'Zool']);
  });

  it('groups the real-world "9Fingers_D1/_D2" pair into one two-disk game', () => {
    const games = groupDisks([
      d('9Fingers_D1.adf', 'a'),
      d('9Fingers_D2.adf', 'b'),
    ]);
    expect(games).toHaveLength(1);
    expect(games[0].title).toBe('9Fingers');
    expect(games[0].disks.map((x) => x.diskNo)).toEqual([1, 2]);
    expect(games[0].disks[0].sha256).toBe('a');
    expect(games[0].disks[1].sha256).toBe('b');
  });
});
