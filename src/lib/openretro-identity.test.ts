import { describe, expect, it } from 'vitest';
import { matchIdentity, openretroSortTitle, type IdentityCandidate } from './openretro-identity';
import { makeSortTitle } from './tosec';

const c = (uuid: string, gameName: string, year: number | null): IdentityCandidate =>
  ({ uuid, gameName, year });

describe('openretroSortTitle', () => {
  it('strips the publisher suffix OpenRetro appends and TOSEC does not', () => {
    // Real row from the live table: "The Enforcer [Eurosoft]".
    expect(openretroSortTitle('The Enforcer [Eurosoft]')).toBe('enforcer, the');
  });

  it('strips a trailing parenthetical qualifier too', () => {
    expect(openretroSortTitle('Lemmings (AGA)')).toBe('lemmings');
  });

  it('agrees with the TOSEC side for the same title', () => {
    // The two are compared as equals, so they must normalise identically or
    // every comparison silently fails and this file looks like it does nothing.
    expect(openretroSortTitle('The Secret of Monkey Island'))
      .toBe(makeSortTitle('The Secret of Monkey Island'));
  });

  it('leaves a bracket in the MIDDLE of a name alone', () => {
    // Only a TRAILING qualifier is decoration; one mid-name is part of the title.
    expect(openretroSortTitle('Zak [McKracken] Returns')).toContain('[mckracken]');
  });
});

describe('matchIdentity', () => {
  it('matches a unique title and year', () => {
    expect(matchIdentity('lemmings', 1991, [c('u1', 'Lemmings', 1991)]))
      .toEqual({ state: 'matched', uuid: 'u1' });
  });

  it('ignores candidates whose title does not actually normalise equal', () => {
    // The SQL narrows by title, but narrowing is not proof -- re-checking here
    // is what keeps a loose query from becoming a loose match.
    expect(matchIdentity('lemmings', 1991, [c('u1', 'Lemmings 2', 1993)]))
      .toEqual({ state: 'none' });
  });

  it('refuses when two entries share the title AND the year', () => {
    expect(matchIdentity('worms', 1995, [c('u1', 'Worms', 1995), c('u2', 'Worms', 1995)]))
      .toEqual({ state: 'ambiguous' });
  });

  it('does NOT match a different year, even with nothing else competing', () => {
    // The trap this rule exists for: a 1988 original taking a 1992 remake's
    // screenshots because it was the only row with that name.
    expect(matchIdentity('nebulus', 1987, [c('u1', 'Nebulus', 1991)]))
      .toEqual({ state: 'none' });
  });

  it('picks the right year out of several editions', () => {
    const v = matchIdentity('nebulus', 1991, [
      c('old', 'Nebulus', 1987), c('new', 'Nebulus', 1991), c('none', 'Nebulus', null),
    ]);
    expect(v).toEqual({ state: 'matched', uuid: 'new' });
  });

  describe('when TOSEC carries no year', () => {
    it('matches only if the title is unique in OpenRetro', () => {
      expect(matchIdentity('wayfarer', null, [c('u1', 'Wayfarer', 1989)]))
        .toEqual({ state: 'matched', uuid: 'u1' });
    });

    it('refuses to pick between editions it cannot tell apart', () => {
      expect(matchIdentity('nebulus', null, [c('a', 'Nebulus', 1987), c('b', 'Nebulus', 1991)]))
        .toEqual({ state: 'ambiguous' });
    });
  });

  it('says none when nothing shares the title', () => {
    // The measured majority case for this archive: 15 of 29 TOSEC-identified
    // blobs are demos and applications that a games database simply lacks.
    expect(matchIdentity('9 fingers', null, [c('u1', 'Nine Lives', 1990)]))
      .toEqual({ state: 'none' });
  });

  it('never returns a uuid it was not given', () => {
    const v = matchIdentity('lemmings', 1991, [c('only', 'Lemmings', 1991)]);
    expect(v.state === 'matched' && v.uuid).toBe('only');
  });
});
