// Deviation from the brief: this file lives outside src/db/schema/ because
// drizzle-kit loads every *.ts there, and a Vitest import breaks db:generate.
// src/db/devices-schema.test.ts explains the same constraint.
import { describe, it, expect } from 'vitest';
import { getTableConfig } from 'drizzle-orm/pg-core';
import { diskVersions, diskWriteSessions, diskWriteTracks } from './schema/disk-history';

describe('disk history schema', () => {
  it('a version belongs to a disk and dies with it', () => {
    const cfg = getTableConfig(diskVersions);
    expect(cfg.name).toBe('disk_versions');
    const fk = cfg.foreignKeys.map((f) => f.reference());
    expect(fk.some((r) => tableName(r.foreignTable) === 'disks'
      && f0(r.foreignColumns) === 'id')).toBe(true);
    expect(cfg.foreignKeys.every((f) => f.onDelete === 'cascade')).toBe(true);
  });

  it('seq is unique per disk, and versions are findable by image digest', () => {
    const cfg = getTableConfig(diskVersions);
    expect(cfg.uniqueConstraints.map((u) => u.columns.map((c) => c.name).join(',')))
      .toContain('disk_id,seq');
    expect(cfg.indexes.map((i) => i.config.name)).toContain('disk_versions_image_idx');
  });

  it('one open session per device and mount; one staged row per track', () => {
    expect(getTableConfig(diskWriteSessions).primaryKeys[0].columns.map((c) => c.name))
      .toEqual(['device_id', 'mount']);
    expect(getTableConfig(diskWriteTracks).primaryKeys[0].columns.map((c) => c.name))
      .toEqual(['device_id', 'mount', 'track']);
  });

  it('staged track bytes are bytea, and not null', () => {
    expect(diskWriteTracks.data.getSQLType()).toBe('bytea');
    expect(diskWriteTracks.data.notNull).toBe(true);
  });
});

function f0(cols: { name: string }[]): string { return cols[0]?.name ?? ''; }

// Cast needed: TS sees PgTable's index signature only for string/number keys,
// but drizzle stores the table name under a well-known symbol.
function tableName(table: object): unknown {
  return (table as Record<symbol, unknown>)[Symbol.for('drizzle:Name')];
}
