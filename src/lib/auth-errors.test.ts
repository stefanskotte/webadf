import { describe, it, expect } from 'vitest';
import { authErrorText } from '@/lib/auth-errors';

describe('authErrorText (C5 spec §6.3–6.4, Ruling 34)', () => {
  it("the board's words by code", () => {
    expect(authErrorText('in', { code: 'INVALID_EMAIL_OR_PASSWORD', status: 401, message: 'Invalid email or password' }))
      .toBe('The email or password is not right.');
    expect(authErrorText('up', { code: 'INVALID_INVITE_CODE', status: 400, message: 'Invalid invite code' }))
      .toBe('That invite code is not valid, or it has been used.');
  });
  it('429 is the same sentence on both pages', () => {
    expect(authErrorText('in', { status: 429, message: 'Too many requests. Please try again later.' }))
      .toBe('Too many attempts. Wait a minute and try again.');
    expect(authErrorText('up', { status: 429 })).toBe('Too many attempts. Wait a minute and try again.');
  });
  it("anything else: better-auth's message, else the page's own fallback", () => {
    expect(authErrorText('up', { code: 'USER_ALREADY_EXISTS', status: 422, message: 'User already exists' })).toBe('User already exists');
    expect(authErrorText('in', { status: 500 })).toBe("Couldn't sign in. Try again.");
    expect(authErrorText('up', null)).toBe("Couldn't create the account. Try again.");
  });
  it("a code only maps on its own page", () => {
    expect(authErrorText('up', { code: 'INVALID_EMAIL_OR_PASSWORD', message: 'm' })).toBe('m');
    expect(authErrorText('in', { code: 'INVALID_INVITE_CODE', message: 'm' })).toBe('m');
  });
});
