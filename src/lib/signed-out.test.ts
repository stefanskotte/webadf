import { describe, it, expect } from 'vitest';
import { isSignedOutAnswer } from './signed-out';

// Moved from upload-staging.test.ts when the Upload page's Staging list retired (Files increment 3).
describe('isSignedOutAnswer', () => {
  const res = (o: { redirected?: boolean; type?: string | null; status?: number }) =>
    ({ redirected: o.redirected ?? false, status: o.status ?? 200, ok: (o.status ?? 200) < 300,
       headers: new Headers(o.type === null ? {} : { 'content-type': o.type ?? 'application/json' }) }) as Response;
  it('a JSON answer is not signed out', () => {
    expect(isSignedOutAnswer(res({}))).toBe(false);
    expect(isSignedOutAnswer(res({ type: 'application/json; charset=utf-8', status: 409 }))).toBe(false);
  });
  it('a redirected answer is signed out, whatever its type', () => {
    expect(isSignedOutAnswer(res({ redirected: true }))).toBe(true);
    expect(isSignedOutAnswer(res({ redirected: true, type: 'text/html' }))).toBe(true);
  });
  it('a 200 HTML page (the sign-in page) is signed out', () => {
    expect(isSignedOutAnswer(res({ type: 'text/html; charset=utf-8' }))).toBe(true);
  });
  it('an HTML error page (a 500, a 404) stays an ordinary failure', () => {
    expect(isSignedOutAnswer(res({ type: 'text/html', status: 500 }))).toBe(false);
    expect(isSignedOutAnswer(res({ type: 'text/html', status: 404 }))).toBe(false);
  });
  it('a 204 with no body is not signed out unless redirected', () => {
    expect(isSignedOutAnswer(res({ status: 204, type: null }))).toBe(false);
    expect(isSignedOutAnswer(res({ status: 204, type: null, redirected: true }))).toBe(true);
  });
});
