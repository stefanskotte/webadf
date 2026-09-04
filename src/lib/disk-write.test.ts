// Unit tests for applyDiskEdit's orchestration, following the mocking
// convention src/lib/storage.test.ts already established for an external
// dependency: the underlying primitives are replaced with vi.fn()s rather
// than the module under test being reshaped to fit a test double. Nothing
// in this repo mocks the database directly yet, so the fake `getDb()` here
// is deliberately narrow -- it supports exactly the chain shapes
// applyDiskEdit calls (select/from/innerJoin/where/limit,
// insert/values/onConflictDoNothing, update/set/where) and nothing more.
// Table identity is checked by reference against the real schema modules,
// which are safe to import: a pgTable() call builds metadata only and opens
// no connection.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createHash } from 'node:crypto';
import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { disks, blobs, entitlements } from '@/db/schema/catalog';
import { devices } from '@/db/schema/devices';
import type { WriteResult } from '@/lib/adffs';

// Drizzle's own dialect, used only to render a captured `.where(...)`
// condition back to the SQL text and bound params it would actually send --
// the same rendering `getDb()` uses before a real query ever reaches
// Postgres. This is how FINDING 1 and FINDING 2 get proven rather than
// merely asserted: a fake `.where()` that ignored its argument could not
// tell "checks mountedSha256 OR desiredSha256" apart from "checks only
// mountedSha256", or "scoped by orgId" apart from "scoped by id alone" --
// every branch would produce an identical queued result either way.
const dialect = new PgDialect();
function renderWhere(cond: unknown): { sql: string; params: unknown[] } {
  return dialect.sqlToQuery(cond as SQL);
}

const diskStoreRead = vi.fn();
const diskStorePut = vi.fn();
const diskStoreRemove = vi.fn();
const diskStoreStorageKey = vi.fn((sha: string) => `adf/${sha}`);

vi.mock('@/lib/storage', () => ({
  diskStore: {
    read: diskStoreRead,
    put: diskStorePut,
    remove: diskStoreRemove,
    storageKey: diskStoreStorageKey,
  },
}));

let selectResults: unknown[][] = [];
const insertCalls: { table: unknown; values: unknown }[] = [];
const updateCalls: { table: unknown; set: unknown }[] = [];
const deleteCalls: unknown[] = [];
// One entry per `.select(...)` call, in call order: the disk lookup's
// `.where(...)` argument first, then the device-holder check's.
const whereConditions: unknown[] = [];

/**
 * A fake NeonHttpDatabase. Each call to `.select(...)` consumes the next
 * queued result off `selectResults`, in the exact order applyDiskEdit makes
 * its queries: the disk lookup first, then the device-holder check. That
 * coupling to call order is the price of not standing up a real database
 * for a unit test; disk-write.test.ts owns it rather than leaving it
 * implicit. `.where(...)`'s argument is captured, not discarded, so tests
 * can render it back to real SQL and prove what it actually scopes on.
 */
function fakeDb() {
  const select = () => {
    const result = selectResults.shift() ?? [];
    const chain = {
      from: () => chain,
      innerJoin: () => chain,
      where: (cond: unknown) => { whereConditions.push(cond); return chain; },
      limit: () => Promise.resolve(result),
    };
    return chain;
  };
  const insert = (table: unknown) => ({
    values: (values: unknown) => {
      insertCalls.push({ table, values });
      return { onConflictDoNothing: () => Promise.resolve(undefined) };
    },
  });
  const update = (table: unknown) => ({
    set: (values: unknown) => {
      updateCalls.push({ table, set: values });
      return { where: () => Promise.resolve(undefined) };
    },
  });
  const del = (table: unknown) => {
    deleteCalls.push(table);
    return { where: () => Promise.resolve(undefined) };
  };
  return { select, insert, update, delete: del };
}

vi.mock('@/db', () => ({ getDb: () => fakeDb() }));

function tableName(table: unknown): string {
  if (table === disks) return 'disks';
  if (table === blobs) return 'blobs';
  if (table === entitlements) return 'entitlements';
  if (table === devices) return 'devices';
  return 'unknown';
}

const ORG_ID = 'org-1';
const DISK_ID = 'disk-1';
const OLD_SHA = 'a'.repeat(64);
const DISK_ROW = { sha256: OLD_SHA, tosecName: 'Game.adf', sourceFilename: 'Game.adf' };

beforeEach(() => {
  vi.clearAllMocks();
  diskStoreStorageKey.mockImplementation((sha: string) => `adf/${sha}`);
  selectResults = [];
  insertCalls.length = 0;
  updateCalls.length = 0;
  deleteCalls.length = 0;
  whereConditions.length = 0;
});

describe('applyDiskEdit', () => {
  it('returns 404, never 403, for a disk outside this org', async () => {
    selectResults = [[]]; // the org-scoped join finds nothing
    const edit = vi.fn();
    const { applyDiskEdit } = await import('@/lib/disk-write');

    const result = await applyDiskEdit(ORG_ID, DISK_ID, edit);

    expect(result).toEqual({ ok: false, status: 404, reason: 'not_found' });
    expect(edit).not.toHaveBeenCalled();

    // PROVES the org scoping, not just the 404 shape: a lookup accidentally
    // scoped by disks.id alone (orgId dropped) would still hit this queued
    // empty result and produce the same 404 -- the point of this repo's
    // cross-org isolation is that the WHERE clause itself never lets that
    // row match, not merely that this particular fixture returns nothing.
    expect(whereConditions).toHaveLength(1);
    const lookup = renderWhere(whereConditions[0]);
    expect(lookup.sql).toContain('"disks"."org_id"');
    expect(lookup.sql).toContain('"disks"."id"');
    expect(lookup.params).toEqual(expect.arrayContaining([ORG_ID, DISK_ID]));
  });

  it('refuses when a device has the disk mounted', async () => {
    selectResults = [
      [DISK_ROW],                 // the disk lookup
      [{ name: 'Amiga 500 #1' }], // a device holding it, mounted or desired
    ];
    const edit = vi.fn();
    const { applyDiskEdit } = await import('@/lib/disk-write');

    const result = await applyDiskEdit(ORG_ID, DISK_ID, edit);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected a refusal');
    expect(result.status).toBe(409);
    // Named, so the operator knows where to eject it from -- not just that
    // something, somewhere, refused.
    expect(result.reason).toContain('Amiga 500 #1');

    // Nothing was read or written: the refusal happens before any of that.
    expect(edit).not.toHaveBeenCalled();
    expect(diskStoreRead).not.toHaveBeenCalled();
    expect(diskStorePut).not.toHaveBeenCalled();

    // PROVES both mount columns are checked, not just that a 409 came back:
    // a fixture with the holder row already queued would produce the same
    // 409 whether the real WHERE clause tested mountedSha256 OR
    // desiredSha256 (correct, D-W-4) or only one of them -- a regression
    // that silently dropped the desiredSha256 branch would be invisible
    // without inspecting the clause itself.
    expect(whereConditions).toHaveLength(2);
    const holderCheck = renderWhere(whereConditions[1]);
    expect(holderCheck.sql).toContain('"devices"."mounted_sha256"');
    expect(holderCheck.sql).toContain('"devices"."desired_sha256"');
    expect(holderCheck.sql).toContain('"devices"."org_id"');
    expect(holderCheck.params).toEqual(expect.arrayContaining([ORG_ID, OLD_SHA]));
  });

  it('keeps disks.id and changes disks.sha256', async () => {
    const before = new Uint8Array([1, 2, 3]);
    const after = new Uint8Array([4, 5, 6, 7]);
    const newSha = createHash('sha256').update(after).digest('hex');

    selectResults = [[DISK_ROW], []]; // no device holds it
    diskStoreRead.mockResolvedValue(before);

    const { applyDiskEdit } = await import('@/lib/disk-write');
    const edit = (adf: Uint8Array): WriteResult => {
      expect(adf).toEqual(before); // the closure gets the CURRENT bytes
      return { ok: true, adf: after };
    };

    const result = await applyDiskEdit(ORG_ID, DISK_ID, edit);

    expect(result).toEqual({ ok: true, sha256: newSha });

    const diskUpdate = updateCalls.find((c) => tableName(c.table) === 'disks');
    expect(diskUpdate).toBeDefined();
    // sha256 moves, id never appears in the SET at all -- the standing rule
    // that disks.id never changes is enforced by never writing to it, not by
    // writing the same value back.
    expect(diskUpdate!.set).toEqual({ sha256: newSha });
    expect(diskUpdate!.set).not.toHaveProperty('id');

    expect(diskStorePut).toHaveBeenCalledWith(newSha, after);
  });

  it('never deletes the old blob', async () => {
    const before = new Uint8Array([1, 2, 3]);
    const after = new Uint8Array([9, 9, 9]);

    selectResults = [[DISK_ROW], []];
    diskStoreRead.mockResolvedValue(before);

    const { applyDiskEdit } = await import('@/lib/disk-write');
    await applyDiskEdit(ORG_ID, DISK_ID, () => ({ ok: true, adf: after }));

    // No delete of any kind, and diskStore.remove is never called: the old
    // sha256 -- global, content-addressed, possibly held by other tenants --
    // is left exactly as it was. Only blob-gc.ts ever removes a blob.
    expect(deleteCalls).toHaveLength(0);
    expect(diskStoreRemove).not.toHaveBeenCalled();

    // The new blob and entitlement are inserted, never used to overwrite
    // the old ones.
    expect(insertCalls.some((c) => tableName(c.table) === 'blobs')).toBe(true);
    expect(insertCalls.some((c) => tableName(c.table) === 'entitlements')).toBe(true);
  });

  it('maps a WriteResult error to a 400 carrying its reason', async () => {
    selectResults = [[DISK_ROW], []];
    diskStoreRead.mockResolvedValue(new Uint8Array([1]));

    const { applyDiskEdit } = await import('@/lib/disk-write');
    const result = await applyDiskEdit(ORG_ID, DISK_ID, () => ({ ok: false, reason: 'disk-full' }));

    expect(result).toEqual({ ok: false, status: 400, reason: 'disk-full' });
    expect(diskStorePut).not.toHaveBeenCalled();
    expect(updateCalls).toHaveLength(0);
  });
});
