import { describe, it, expect } from 'vitest';
import { getTableConfig } from 'drizzle-orm/pg-core';
import { devices } from './devices';

describe('devices: the disk mounted into DF1 (spec 2026-10-14 §4.1)', () => {
  it('df1_disk_id references disks.id and is set null when the disk goes', () => {
    const cfg = getTableConfig(devices);
    const fk = cfg.foreignKeys.find((f) => f.reference().columns.some((c) => c.name === 'df1_disk_id'));
    expect(fk).toBeDefined();
    expect(getTableConfig(fk!.reference().foreignTable).name).toBe('disks');
    expect(fk!.reference().foreignColumns.map((c) => c.name)).toEqual(['id']);
    expect(fk!.onDelete).toBe('set null');
    expect(cfg.columns.find((c) => c.name === 'df1_disk_id')!.notNull).toBe(false);
  });

  it('df1_version is an integer cursor that starts at 0', () => {
    const col = getTableConfig(devices).columns.find((c) => c.name === 'df1_version')!;
    expect(col.getSQLType()).toBe('integer');
    expect(col.notNull).toBe(true);
    expect(col.default).toBe(0);
  });
});
