// Deviation from the brief: the brief places this file at
// src/db/schema/devices.test.ts. drizzle-kit's `schema` glob in
// drizzle.config.ts is './src/db/schema/*.ts', which is a flat match on file
// extension -- it does not distinguish *.test.ts from real schema modules.
// `pnpm db:generate` tries to require() every match as CJS, and Vitest's
// package refuses to load under require(), so db:generate died with
// "Vitest cannot be imported in a CommonJS module using require()" the
// moment a .test.ts file existed in that directory. drizzle.config.ts is
// off-limits to edit per the task instructions, so the test lives one
// directory up instead -- still matched by vitest's `src/**/*.test.ts`
// include, following the precedent of src/db/scope.test.ts.
import { describe, it, expect } from 'vitest';
import { devices, invites, pairingCodes } from './schema/devices';
import * as deviceSchema from './schema/devices';
import { disks } from './schema/catalog';

describe('devices desired-state columns', () => {
  it('carries a nullable desired disk and a monotonic version', () => {
    expect(devices.desiredSha256.notNull).toBe(false);
    expect(devices.desiredGameId.notNull).toBe(false);
    expect(devices.desiredDiskNo.notNull).toBe(false);
    expect(devices.desiredDiskId.notNull).toBe(false);
    expect(devices.desiredSetAt.notNull).toBe(false);
    expect(devices.desiredVersion.notNull).toBe(true);
    expect(devices.desiredVersion.hasDefault).toBe(true);
  });

  it('separates what was reported from what was asked for', () => {
    // Collapsing these would make "disk 1 mounted, disk 2 requested, device
    // last seen 4 minutes ago" unrepresentable -- exactly the state a human
    // needs when the service has been unreachable. Spec §3.
    expect(devices.mountedSha256.notNull).toBe(false);
    expect(devices.mountedGameId).toBeDefined();
    expect(devices.desiredSha256).toBeDefined();
  });

  it('has somewhere to put the reason a mount failed', () => {
    expect(devices.lastError.notNull).toBe(false);
    expect(devices.lastErrorAt.notNull).toBe(false);
  });

  it('no longer defines mount_jobs', () => {
    expect('mountJobs' in deviceSchema).toBe(false);
  });
});

describe('disks.writeProtected', () => {
  it('is not null and defaults to protected', () => {
    expect(disks.writeProtected.notNull).toBe(true);
    expect(disks.writeProtected.hasDefault).toBe(true);
    expect(disks.writeProtected.default).toBe(true);
  });

  it('is a real boolean column, not text or an integer flag', () => {
    expect(disks.writeProtected.getSQLType()).toBe('boolean');
  });
});

describe('SQL-facing identity of the new columns', () => {
  // `.notNull` / `.hasDefault` describe constraints, not the underlying SQL
  // type or column name -- a column can satisfy both while being the wrong
  // type (e.g. text instead of integer) or having drifted to the wrong
  // db-facing name under an unchanged TS property. Assert both explicitly so
  // a rename or type swap fails here instead of surfacing later as a
  // spurious `db:generate` diff against production.

  it('desiredVersion is an integer, not a timestamp or string', () => {
    // The long-poll compares a device's `since` against this value. An
    // integer is unambiguous under clock skew and under two updates landing
    // in the same millisecond, where a timestamp (or a stringly-typed
    // "integer") is not. Spec §4.
    expect(devices.desiredVersion.getSQLType()).toBe('integer');
  });

  it('desiredSetAt and lastErrorAt keep their time zone', () => {
    // A bare `timestamp` column silently drops the zone and shifts times
    // for any client not in UTC.
    expect(devices.desiredSetAt.getSQLType()).toBe('timestamp with time zone');
    expect(devices.lastErrorAt.getSQLType()).toBe('timestamp with time zone');
  });

  it('desiredDiskId is a text primary-key reference, not an integer', () => {
    // (gameId, diskNo, orgId) is not a unique triple -- re-ingesting a
    // corrected image for the same game and disk number lands a second
    // disks row. readDesired joins on this column instead, which is
    // provably one row because it targets disks.id, the primary key.
    expect(devices.desiredDiskId.getSQLType()).toBe('text');
  });

  it('every column this task added has the expected db-facing name', () => {
    expect(devices.mountedSha256.name).toBe('mounted_sha256');
    expect(devices.desiredSha256.name).toBe('desired_sha256');
    expect(devices.desiredGameId.name).toBe('desired_game_id');
    expect(devices.desiredDiskNo.name).toBe('desired_disk_no');
    expect(devices.desiredDiskId.name).toBe('desired_disk_id');
    expect(devices.desiredSetAt.name).toBe('desired_set_at');
    expect(devices.desiredVersion.name).toBe('desired_version');
    expect(devices.lastError.name).toBe('last_error');
    expect(devices.lastErrorAt.name).toBe('last_error_at');
    expect(disks.writeProtected.name).toBe('write_protected');
  });
});

describe('devices.mountedDiskId and mountedVersion (F-3)', () => {
  // Without these, plan 3b's §7 rendering would have to resolve
  // mounted_sha256 back to a disk row by (orgId, sha256) -- exactly the
  // non-unique lookup desiredDiskId was added to avoid on the desired side.
  it('are both nullable', () => {
    expect(devices.mountedDiskId.notNull).toBe(false);
    expect(devices.mountedVersion.notNull).toBe(false);
  });

  it('have the expected db-facing name and SQL type', () => {
    expect(devices.mountedDiskId.name).toBe('mounted_disk_id');
    expect(devices.mountedDiskId.getSQLType()).toBe('text');
    expect(devices.mountedVersion.name).toBe('mounted_version');
    expect(devices.mountedVersion.getSQLType()).toBe('integer');
  });
});
