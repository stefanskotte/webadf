import { describe, it, expect } from 'vitest';
import { NextRequest } from 'next/server';
import { GET } from './route';

const get = (qs: string) => GET(new NextRequest(`http://x/ingest${qs}`));

describe('GET /ingest: a 307 to the Files page (increment 3, R10)', () => {
  it('sends /ingest to /files', async () => {
    const res = await get('');
    expect(res.status).toBe(307);
    expect(res.headers.get('location')).toBe('/files');
  });
  it('keeps the board: ?board= opens its queue, ?from= opens STASH: beside it', async () => {
    expect((await get('?board=dev1')).headers.get('location')).toBe('/files?left=STASH:&right=NET%3A%2Fdev1%2FQueue&active=right');
    expect((await get('?from=dev1')).headers.get('location')).toBe('/files?left=STASH:&right=NET%3A%2Fdev1%2FQueue&active=left');
  });
  it('a repeated board names no one board', async () => {
    expect((await get('?board=a&board=b')).headers.get('location')).toBe('/files');
  });
});
