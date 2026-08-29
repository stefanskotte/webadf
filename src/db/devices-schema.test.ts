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
});
