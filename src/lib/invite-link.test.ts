import { describe, it, expect } from 'vitest';
import { inviteSignUpUrl } from './invite-link';

describe('inviteSignUpUrl', () => {
  it('builds the sign-up link from an origin', () => {
    expect(inviteSignUpUrl('https://webfloppy.example', 'ABCD2345')).toBe('https://webfloppy.example/sign-up?invite=ABCD2345');
  });
  it('drops a trailing slash on the origin and encodes the code', () => {
    expect(inviteSignUpUrl('http://nas.lan:3000/', 'A B')).toBe('http://nas.lan:3000/sign-up?invite=A%20B');
  });
});
