// Lives here rather than under src/db/schema/ for the reason spelled out at
// the top of devices-schema.test.ts: drizzle-kit's schema glob is a flat
// './src/db/schema/*.ts' and would try to require() a test file.
import { describe, it, expect } from 'vitest';
import { getTableConfig } from 'drizzle-orm/pg-core';
import { firmwareReleases } from './schema/firmware';

describe('firmware_releases', () => {
  const t = getTableConfig(firmwareReleases);
  const col = (name: string) => t.columns.find((c) => c.name === name);

  it('is named firmware_releases', () => {
    expect(t.name).toBe('firmware_releases');
  });

  it('carries every column a release is identified and verified by', () => {
    for (const name of [
      'id', 'version', 'sequence', 'semver', 'sha256', 'size_bytes', 'blob_path',
      'signature', 'signing_key_id', 'notes', 'security', 'published_at',
      'published_by_user_id',
    ]) {
      expect(col(name), `missing column ${name}`).toBeDefined();
    }
  });

  // Both are the registry's identity. A duplicate version would make the
  // lookup that decides "is this board behind" ambiguous; a duplicate
  // sequence would make the ordering ambiguous, and the sequence is what
  // increment 2's anti-rollback rule reads.
  it('makes version and sequence unique', () => {
    const names = t.uniqueConstraints.map((u) => u.name);
    expect(names).toContain('firmware_releases_version_key');
    expect(names).toContain('firmware_releases_sequence_key');
  });

  it('requires the fields a release cannot be published without', () => {
    for (const name of ['version', 'sequence', 'semver', 'sha256', 'size_bytes',
                        'blob_path', 'signature', 'signing_key_id', 'published_by_user_id']) {
      expect(col(name)!.notNull, `${name} must be NOT NULL`).toBe(true);
    }
  });

  // A signature is required from the very first release even though nothing
  // verifies one yet (spec §4). Making it nullable "for now" is how a
  // registry ends up with history that increment 2 cannot check.
  it('requires a signature even though nothing verifies it yet', () => {
    expect(col('signature')!.notNull).toBe(true);
    expect(col('signing_key_id')!.notNull).toBe(true);
  });

  it('defaults security to false, so a release is only loud on purpose', () => {
    expect(col('security')!.notNull).toBe(true);
    expect(col('security')!.hasDefault).toBe(true);
  });

  // Release notes are the one thing a human writes here, and a release with
  // nothing to say is ordinary.
  it('allows a release with no notes', () => {
    expect(col('notes')!.notNull).toBe(false);
  });
});
