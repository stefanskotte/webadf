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
