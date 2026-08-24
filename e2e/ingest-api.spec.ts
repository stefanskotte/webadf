import { test, expect } from '@playwright/test';
import { createHash } from 'node:crypto';
import { signUpFresh } from './helpers';

test('check reports an unknown hash as missing', async ({ page, request }) => {
  await signUpFresh(page); // seeds the session cookie into the context

  const sha = createHash('sha256').update(`unique-${Date.now()}`).digest('hex');
  const res = await page.request.post('/api/ingest/check', { data: { hashes: [sha] } });

  expect(res.status()).toBe(200);
  expect(await res.json()).toEqual({ known: [], missing: [sha] });
});

test('check rejects a malformed hash with 400', async ({ page }) => {
  await signUpFresh(page);
  const res = await page.request.post('/api/ingest/check', { data: { hashes: ['nope'] } });
  expect(res.status()).toBe(400);
});

test('ingest endpoints reject an anonymous caller', async ({ request }) => {
  const res = await request.post('/api/ingest/check', {
    data: { hashes: ['a'.repeat(64)] },
    maxRedirects: 0,
  });
  expect(res.status()).not.toBe(200);
});
