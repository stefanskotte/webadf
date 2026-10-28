import { describe, it, expect } from 'vitest';
import { parseShareLink, SHARE_CODE_RE } from './link';

const CODE = 'wfsc_' + 'A'.repeat(20) + '-_' + 'z9'.repeat(10) + 'q';
const PIN = 'p'.repeat(20) + '_-' + '0'.repeat(21);
const LINK = `https://floppy.example.com/s/${CODE}`;
const PINNED = `${LINK}#pin=${PIN}`;
const NO_ENV = {};
const INSECURE = { WEBADF_SHARE_TEST_INSECURE: '1' };

describe('fixtures', () => {
  it('the code fixture is a valid code', () => {
    expect(CODE).toHaveLength(48);
    expect(SHARE_CODE_RE.test(CODE)).toBe(true);
    expect(PIN).toHaveLength(43);
  });
});

describe('parseShareLink: the shapes Add must accept (Review Focus 4)', () => {
  const plain = { origin: 'https://floppy.example.com', code: CODE, pin: null };
  const pinned = { ...plain, pin: PIN };

  it('the link as the owner copied it', () => {
    expect(parseShareLink(LINK, NO_ENV)).toEqual(plain);
    expect(parseShareLink(PINNED, NO_ENV)).toEqual(pinned);
  });

  it('surrounding whitespace, newlines included', () => {
    expect(parseShareLink(`  \n\t${LINK} \n`, NO_ENV)).toEqual(plain);
    expect(parseShareLink(`  ${PINNED}\n`, NO_ENV)).toEqual(pinned);
  });

  it('a trailing slash', () => {
    expect(parseShareLink(`${LINK}/`, NO_ENV)).toEqual(plain);
    expect(parseShareLink(`${LINK}/#pin=${PIN}`, NO_ENV)).toEqual(pinned);
  });

  it('the recipient landing URL with #link= percent-encoded', () => {
    const add = `https://mine.example.org/remote/add#link=${encodeURIComponent(PINNED)}`;
    expect(parseShareLink(add, NO_ENV)).toEqual(pinned);
    expect(parseShareLink(`https://mine.example.org/remote/add#link=${encodeURIComponent(LINK)}`, NO_ENV)).toEqual(plain);
  });

  it('the recipient landing URL with #link= not encoded', () => {
    expect(parseShareLink(`https://mine.example.org/remote/add#link=${PINNED}`, NO_ENV)).toEqual(pinned);
    expect(parseShareLink(` https://mine.example.org/remote/add/#link=${LINK}/ `, NO_ENV)).toEqual(plain);
  });

  it('a port and an upper-case host are kept as the origin', () => {
    expect(parseShareLink(`https://Floppy.Example.com:8443/s/${CODE}`, NO_ENV))
      .toEqual({ origin: 'https://floppy.example.com:8443', code: CODE, pin: null });
  });
});

describe('parseShareLink: refusals', () => {
  it.each([
    [''], ['   '], ['garbage'], ['not a url at all'], [CODE], ['https://'], ['mailto:x@y'],
    [`https://floppy.example.com/s/`],
    [`https://floppy.example.com/s/wfst_${'A'.repeat(43)}`],      // a token, not a code
    [`https://floppy.example.com/s/wfsc_${'A'.repeat(42)}`],      // too short
    [`https://floppy.example.com/s/wfsc_${'A'.repeat(44)}`],      // too long
    [`https://floppy.example.com/s/wfsc_${'A'.repeat(42)}+`],     // not base64url
    [`https://floppy.example.com/x/${CODE}`],                     // wrong path
    [`https://floppy.example.com/base/s/${CODE}`],                // a sub-path is not an origin
    [`https://floppy.example.com/s/${CODE}/extra`],
    [`https://user:pw@floppy.example.com/s/${CODE}`],             // credentials
    [`ftp://floppy.example.com/s/${CODE}`],
    [`http://floppy.example.com/s/${CODE}`],                      // http without TEST_INSECURE
    [`${LINK}#pin=short`],                                        // a malformed pin is not silently dropped
    [`${LINK}#pin=${PIN}x`],
    [`https://mine.example.org/remote/add`],
    [`https://mine.example.org/remote/add#link=garbage`],
    [`https://mine.example.org/remote/add#link=%E0%A4%A`],        // bad percent-encoding
    [`https://mine.example.org/elsewhere#link=${encodeURIComponent(LINK)}`],
  ])('refuses %j', (raw) => {
    expect(parseShareLink(raw, NO_ENV)).toBeNull();
  });

  it('decodes #link= once only: a link wrapped twice is refused', () => {
    const once = `https://mine.example.org/remote/add#link=${encodeURIComponent(LINK)}`;
    const twice = `https://other.example.org/remote/add#link=${encodeURIComponent(once)}`;
    expect(parseShareLink(twice, NO_ENV)).toBeNull();
  });

  it('refuses non-strings', () => {
    expect(parseShareLink(undefined as unknown as string, NO_ENV)).toBeNull();
    expect(parseShareLink(42 as unknown as string, NO_ENV)).toBeNull();
  });

  it('refuses an absurdly long input', () => {
    expect(parseShareLink(`${LINK}#pin=${PIN}&x=${'a'.repeat(5000)}`, NO_ENV)).toBeNull();
  });
});

describe('parseShareLink: http only under WEBADF_SHARE_TEST_INSECURE=1', () => {
  it('accepts http when the test switch is on', () => {
    expect(parseShareLink(`http://127.0.0.1:3100/s/${CODE}`, INSECURE))
      .toEqual({ origin: 'http://127.0.0.1:3100', code: CODE, pin: null });
  });

  it('any other value keeps http refused', () => {
    expect(parseShareLink(`http://127.0.0.1:3100/s/${CODE}`, { WEBADF_SHARE_TEST_INSECURE: 'true' })).toBeNull();
  });

  it('reads process.env when no env is passed', () => {
    expect(parseShareLink(LINK)).toEqual({ origin: 'https://floppy.example.com', code: CODE, pin: null });
  });
});
