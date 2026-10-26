import { describe, it, expect } from 'vitest';
import { shownInviteCode } from './invite-issue';

describe('shownInviteCode: the panel never shows a code that is no longer live', () => {
  it('shows the issued code while the server lists it as live', () => {
    expect(shownInviteCode('ABCD2345', ['ABCD2345', 'ZZZZ2222'])).toBe('ABCD2345');
  });
  it('hides it once it is revoked, used or expired (absent from the live list)', () => {
    expect(shownInviteCode('ABCD2345', ['ZZZZ2222'])).toBeNull();
    expect(shownInviteCode('ABCD2345', [])).toBeNull();
  });
  it('shows nothing before any issue', () => {
    expect(shownInviteCode(null, ['ABCD2345'])).toBeNull();
  });
});
