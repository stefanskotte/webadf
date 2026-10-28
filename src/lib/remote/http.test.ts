import { describe, it, expect } from 'vitest';
import { remoteFailure } from './http';

describe('remoteFailure (final review 3, 6)', () => {
  it.each([
    ['protocol', { detail: 'local_older' }, 409, { error: 'protocol', host: 'h.example', detail: 'local_older' }],
    ['protocol', {}, 409, { error: 'protocol', host: 'h.example' }],
    ['bad_response', { detail: 'json' }, 502, { error: 'bad_response', host: 'h.example' }],
    ['token_unreadable', {}, 409, { error: 'token_unreadable' }],
    ['unreachable', {}, 502, { error: 'unreachable', host: 'h.example' }],
    ['ended', {}, 410, { error: 'ended' }],
  ] as const)('%s %j -> %i %j', async (failure, opts, status, body) => {
    const res = remoteFailure(failure, 'h.example', opts);
    expect(res.status).toBe(status);
    expect(await res.json()).toEqual(body);
  });
});
