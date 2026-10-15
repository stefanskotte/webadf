import { describe, it, expect } from 'vitest';
import { migrationState, backupName, prunable, pgEnv } from './migrate';

const e = [{ when: 100, tag: '0000_a' }, { when: 200, tag: '0001_b' }, { when: 300, tag: '0002_c' }];

describe('migrationState', () => {
  it('fresh database: everything pending', () => {
    expect(migrationState(e, null)).toEqual({ pending: ['0000_a', '0001_b', '0002_c'], newer: false, imageLatest: '0002_c' });
  });
  it('up to date: nothing pending, so no backup will be taken', () => {
    expect(migrationState(e, 300)).toEqual({ pending: [], newer: false, imageLatest: '0002_c' });
  });
  it('behind: only the later ones', () => {
    expect(migrationState(e, 200).pending).toEqual(['0002_c']);
  });
  it('a database newer than the image', () => {
    expect(migrationState(e, 400).newer).toBe(true);
  });
});

describe('backups', () => {
  it('names a backup by UTC time and first pending migration', () => {
    expect(backupName(new Date('2026-10-15T18:30:00.123Z'), '0039_x')).toBe('20261015T183000Z-before-0039_x.dump');
  });
  it('keeps the newest N and ignores other files', () => {
    const names = ['20261001T000000Z-before-a.dump', '20261003T000000Z-before-c.dump', 'notes.txt', '20261002T000000Z-before-b.dump'];
    expect(prunable(names, 2)).toEqual(['20261001T000000Z-before-a.dump']);
  });
});

describe('pgEnv', () => {
  it('passes connection parts by environment, the password only as PGPASSWORD', () => {
    const env = pgEnv('postgresql://us%40er:p%2Fw%3Ad@db.example:5433/my%20db');
    expect(env).toEqual({ PGHOST: 'db.example', PGPORT: '5433', PGUSER: 'us@er', PGPASSWORD: 'p/w:d', PGDATABASE: 'my db' });
    for (const v of Object.values(env)) expect(v).not.toContain('://');
    expect(Object.entries(env).filter(([, v]) => v.includes('p/w:d')).map(([k]) => k)).toEqual(['PGPASSWORD']);
  });
  it('omits what the URL does not carry', () => {
    expect(pgEnv('postgresql://h/d')).toEqual({ PGHOST: 'h', PGDATABASE: 'd' });
  });
});
