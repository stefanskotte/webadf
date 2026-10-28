import { describe, expect, it } from 'vitest';
import { expiredSignInHref, isSessionNotFresh, safeReturnPath } from './sign-in-return';

describe('safeReturnPath', () => {
  it('keeps a same-site path', () => {
    expect(safeReturnPath('/settings')).toBe('/settings');
    expect(safeReturnPath('/library?q=gods')).toBe('/library?q=gods');
  });
  it('falls back to / for anything that could leave the site or is not a path', () => {
    for (const raw of ['//evil.example', '/\\evil.example', 'https://evil.example', 'settings', '', undefined, ['/a'], 42]) {
      expect(safeReturnPath(raw)).toBe('/');
    }
  });
});

describe('isSessionNotFresh', () => {
  it("recognises Better Auth's SESSION_NOT_FRESH APIError", () => {
    expect(isSessionNotFresh({ status: 'FORBIDDEN', body: { message: 'Session is not fresh', code: 'SESSION_NOT_FRESH' } }))
      .toBe(true);
  });
  it('ignores every other error', () => {
    expect(isSessionNotFresh({ body: { code: 'UNAUTHORIZED' } })).toBe(false);
    expect(isSessionNotFresh(new Error('boom'))).toBe(false);
    expect(isSessionNotFresh(null)).toBe(false);
  });
});

describe('expiredSignInHref', () => {
  it('carries the expired flag and the encoded return path', () => {
    expect(expiredSignInHref('/settings')).toBe('/sign-in?expired=1&next=%2Fsettings');
  });
});
