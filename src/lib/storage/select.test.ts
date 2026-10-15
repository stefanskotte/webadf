import { it, expect } from 'vitest';
import { selectBackend } from './select';

// Constructing a backend must do no I/O: the Vercel one is only built here,
// never called, so no test ever reaches the real store.
it.each([
  [{ BLOB_READ_WRITE_TOKEN: 'vercel_blob_rw_x' }, 'Vercel Blob'],
  [{}, 'Local disk'],
  [{ BLOB_READ_WRITE_TOKEN: '' }, 'Local disk'],
  [{ BLOB_READ_WRITE_TOKEN: '   ' }, 'Local disk'],
])('%j -> %s', (env, label) => {
  expect(selectBackend({ ...env, STORAGE_DIR: '/tmp/webadf-select-test' }).label).toBe(label);
});

// On Vercel a function's disk is ephemeral: no silent fallback there.
it('VERCEL=1 without a token throws instead of falling back to local disk', () => {
  expect(() => selectBackend({ VERCEL: '1' })).toThrow(/running on Vercel without BLOB_READ_WRITE_TOKEN/);
  expect(() => selectBackend({ VERCEL: '1', BLOB_READ_WRITE_TOKEN: '  ' })).toThrow(/refusing to fall back/);
});

it('VERCEL=1 with a token -> Vercel Blob', () => {
  expect(selectBackend({ VERCEL: '1', BLOB_READ_WRITE_TOKEN: 'vercel_blob_rw_x' }).label).toBe('Vercel Blob');
});

it('no VERCEL and no token -> Local disk (unchanged)', () => {
  expect(selectBackend({ VERCEL: '', STORAGE_DIR: '/tmp/webadf-select-test' }).label).toBe('Local disk');
});
