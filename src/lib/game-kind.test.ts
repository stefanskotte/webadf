import { describe, it, expect } from 'vitest';
import { kindFromSetName, pickKind } from './game-kind';

describe('kindFromSetName', () => {
  it.each([
    ['Commodore Amiga - Games - [ADF]', 'Game'],
    ['Commodore Amiga - Games - Public Domain - [ADF]', 'Game'],
    ['Commodore Amiga - Demos - Various - [ADF]', 'Demo'],
    ['Commodore Amiga - Applications - [ADF]', 'App'],
    ['Commodore Amiga - Applications - Public Domain - [ADF]', 'App'],
    ['Commodore Amiga - Educational - [ADF]', 'Educational'],
    ['Commodore Amiga - Coverdisks - [ADF]', 'Coverdisk'],
  ])('reads %s as %s', (setName, expected) => {
    expect(kindFromSetName(setName)).toBe(expected);
  });

  it('checks Demos before Games so a demo set is never read as a game', () => {
    // "Commodore Amiga - Demos - Various" contains neither word ambiguously
    // today, but the matching is substring-based and order is what keeps it
    // honest if TOSEC ever ships "Games - Demos".
    expect(kindFromSetName('Commodore Amiga - Games - Demos - [ADF]')).toBe('Demo');
  });

  it('returns null for a set it does not recognise', () => {
    // TOSEC ships 4,743 DATs across every system; only seven are Amiga ADF
    // sets. Anything else must read as unknown rather than be forced into
    // a category.
    expect(kindFromSetName('Commodore 64 - Games - [T64]')).toBeNull();
    expect(kindFromSetName('')).toBeNull();
  });
});

describe('pickKind', () => {
  it('is null when no disk is TOSEC-matched', () => {
    // The MAJORITY case: TOSEC recognises 45.9% of the real archive, so most
    // rows have no type at all and the column must stay quiet about it.
    expect(pickKind([])).toBeNull();
  });

  it('uses the kind most of a game\'s disks agree on', () => {
    expect(pickKind(['Game', 'Game', 'Demo'])).toBe('Game');
  });

  it('breaks a tie deterministically rather than by input order', () => {
    // A multi-disk game whose disks come from different sets must not change
    // type between two renders of unchanged data.
    expect(pickKind(['Demo', 'Game'])).toBe(pickKind(['Game', 'Demo']));
  });

  it('ignores unmatched disks instead of letting them outvote a real match', () => {
    // A four-disk game with one matched disk still has a known type.
    expect(pickKind([null, null, 'Game', null])).toBe('Game');
  });
});
