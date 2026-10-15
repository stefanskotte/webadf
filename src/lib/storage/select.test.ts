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
