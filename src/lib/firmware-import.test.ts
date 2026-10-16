import { describe, it, expect } from 'vitest';
import { notesFromBody } from './firmware-import';
import { githubReleasePlan } from './firmware-github-release';

const base = { version: '1.0.0+gabc', semver: '1.0.0', sequence: 1, sha256: 'a'.repeat(64), signature: 's', signingKeyId: 'k', security: false };

describe('notesFromBody', () => {
  it('takes the notes the publisher wrote, not the boilerplate', () => {
    const plan = githubReleasePlan({ ...base, notes: 'Fixes DF1.' });
    if (!plan.publish) throw new Error('not published');
    expect(notesFromBody(plan.body)).toBe('Fixes DF1.');
  });
  it('null for a body with no notes', () => {
    const plan = githubReleasePlan({ ...base, notes: null });
    if (!plan.publish) throw new Error('not published');
    expect(notesFromBody(plan.body)).toBeNull();
    expect(notesFromBody(null)).toBeNull();
  });
});

describe('notesFromBody, the older body format (fw-1.8.1, verbatim from GitHub)', () => {
  const body = [
    'wifi-floppy firmware 1.8.1+g1f343d5 (sequence 50).',
    '',
    'TLS: outgoing record buffer 16 KB -> 4 KB (about 12 KB more free heap per connection); failed firmware downloads now log their cause',
    '',
    'These are the same signed files the web app installs over the air.',
    'manifest.json carries the version, sequence, size, sha256 and the ed25519 signature of wifi_floppy.bin.',
  ].join('\n');
  it('cuts at the "same signed files" paragraph', () => {
    expect(notesFromBody(body)).toBe('TLS: outgoing record buffer 16 KB -> 4 KB (about 12 KB more free heap per connection); failed firmware downloads now log their cause');
  });
});
