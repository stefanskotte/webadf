import { describe, it, expect } from 'vitest';
import { ingestRedirect } from './ingest-redirect';

describe('ingestRedirect: the Upload page URLs keep their board (increment 3, R10)', () => {
  it('maps /ingest, ?board= and ?from=', () => {
    expect(ingestRedirect({})).toBe('/files');
    expect(ingestRedirect({ board: 'dev 1' })).toBe('/files?left=STASH:&right=NET%3A%2Fdev%201&active=right');
    expect(ingestRedirect({ from: 'b2' })).toBe('/files?left=STASH:&right=NET%3A%2Fb2&active=left');
  });
  it('board wins over from; a repeated or empty parameter names no board', () => {
    expect(ingestRedirect({ board: 'a', from: 'b' })).toBe('/files?left=STASH:&right=NET%3A%2Fa&active=right');
    expect(ingestRedirect({ board: ['a', 'b'] })).toBe('/files');
    expect(ingestRedirect({ board: '' })).toBe('/files');
  });
});
