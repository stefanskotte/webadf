import { describe, it, expect } from 'vitest';
import { copiedFromText, lastAnsweredText, remoteErrorText, remoteMarkerText, remoteStatusLook } from './copy';

describe('remoteErrorText (global constraints: UI copy)', () => {
  it.each([
    ['ended', 'floppy.example', undefined, 'Access ended'],
    ['unreachable', 'floppy.example', undefined, "Can't reach floppy.example"],
    ['invalid_or_used', 'floppy.example', undefined, 'This link was already used, has expired or was revoked'],
    ['protocol', 'floppy.example', undefined, 'floppy.example needs a WebFloppy update'],
    ['protocol', 'floppy.example', 'remote_older', 'floppy.example needs a WebFloppy update'],
    ['protocol', 'floppy.example', 'local_older', 'Your WebFloppy needs an update'],
    ['not_shared', 'floppy.example', undefined, 'No longer shared'],
    ['not_found', 'floppy.example', undefined, 'No longer shared'],
    ['rate_limited', 'floppy.example', undefined, 'floppy.example is busy. Try again in a minute.'],
    ['too_large', 'floppy.example', undefined, 'That disk is too large to fetch.'],
    ['mismatch', 'floppy.example', undefined, 'The disk changed while it was being fetched. Try again.'],
    ['already_added', 'floppy.example', undefined, 'This library is already in your Remote list.'],
    ['bad_link', null, undefined, "That doesn't look like a share link. Paste the whole link you were sent."],
    ['no_device', 'floppy.example', undefined, 'That board cannot receive files.'],
  ] as const)('%s (%s, %s) -> %s', (failure, host, detail, text) => {
    expect(remoteErrorText(failure, host, detail)).toBe(text);
  });

  it('names the other WebFloppy when the host is unknown', () => {
    expect(remoteErrorText('unreachable', null)).toBe("Can't reach the other WebFloppy");
    expect(remoteErrorText('protocol', '')).toBe('The other WebFloppy needs a WebFloppy update');
  });

  it('anything else is a plain sentence, never a code', () => {
    for (const f of [undefined, null, '', 'invalid_body', 'boom']) {
      expect(remoteErrorText(f, 'floppy.example')).toBe('Something went wrong. Try again.');
    }
  });
});

describe('remoteStatusLook', () => {
  it('ok is green "Connected"', () => {
    expect(remoteStatusLook('ok', 'floppy.example', null)).toEqual({ kind: 'green', label: 'Connected' });
  });
  it('unreachable names the host', () => {
    expect(remoteStatusLook('unreachable', 'floppy.example', 'unreachable: timeout'))
      .toEqual({ kind: 'amber', label: "Can't reach floppy.example" });
  });
  it('ended says Access ended', () => {
    expect(remoteStatusLook('ended', 'floppy.example', 'ended')).toEqual({ kind: 'red', label: 'Access ended' });
  });
  it('protocol says which side needs the update, from the last error', () => {
    expect(remoteStatusLook('protocol', 'floppy.example', 'protocol: local_older').label).toBe('Your WebFloppy needs an update');
    expect(remoteStatusLook('protocol', 'floppy.example', 'protocol: remote_older').label).toBe('floppy.example needs a WebFloppy update');
    expect(remoteStatusLook('protocol', 'floppy.example', null).label).toBe('floppy.example needs a WebFloppy update');
    expect(remoteStatusLook('protocol', 'floppy.example', null).kind).toBe('amber');
  });
  it('an unknown status reads as unreachable rather than as fine', () => {
    expect(remoteStatusLook('weird' as never, 'h', null).kind).toBe('amber');
  });
});

describe('remoteMarkerText', () => {
  it('is "Remote · <name>"', () => expect(remoteMarkerText("Rob's games")).toBe("Remote · Rob's games"));
});

describe('lastAnsweredText', () => {
  it('a date in UTC', () => {
    expect(lastAnsweredText(new Date('2026-10-28T09:05:00Z'))).toBe('Last answered 28 Oct 2026, 09:05 UTC');
    expect(lastAnsweredText('2026-10-28T09:05:00.000Z')).toBe('Last answered 28 Oct 2026, 09:05 UTC');
  });
  it('never', () => expect(lastAnsweredText(null)).toBe('Never answered'));
});

describe('copiedFromText (spec §4.2 First write notice)', () => {
  it('names the library the copy came from', () => {
    expect(copiedFromText('Rob')).toBe("Your copy of Rob's library");
    expect(copiedFromText('  Amiga Club  ')).toBe("Your copy of Amiga Club's library");
  });
  it('is null for a title that is not a copy', () => {
    expect(copiedFromText(null)).toBeNull();
    expect(copiedFromText(undefined)).toBeNull();
    expect(copiedFromText('   ')).toBeNull();
  });
});
