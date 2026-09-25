import { describe, it, expect } from 'vitest';
import { resolveDiskQuery, type DiskCandidate } from './resolve';

const ID = 'a1b2c3d4-e5f6-5a7b-8c9d-0e1f2a3b4c5d';
const ID2 = 'ffffffff-0000-5000-9000-000000000000';

const disk = (over: Partial<DiskCandidate> & { id: string }): DiskCandidate => ({
  title: 'Some Game', diskNo: 1, tosecName: null, sourceFilename: null, ...over,
});

describe('resolveDiskQuery', () => {
  it('resolves a literal id straight to its row', () => {
    const rows = [disk({ id: ID }), disk({ id: ID2, title: 'Other Game' })];
    expect(resolveDiskQuery(rows, ID)).toEqual({ kind: 'one', disk: rows[0] });
  });

  it('a literal id that matches no row is none, even though it looks like an id', () => {
    const rows = [disk({ id: ID })];
    expect(resolveDiskQuery(rows, ID2)).toEqual({ kind: 'none' });
  });

  it('"<title> disk <N>" picks the matching disk number among several', () => {
    const rows = [
      disk({ id: ID, title: 'Turrican II', diskNo: 1 }),
      disk({ id: ID2, title: 'Turrican II', diskNo: 2 }),
    ];
    expect(resolveDiskQuery(rows, 'Turrican II disk 1')).toEqual({ kind: 'one', disk: rows[0] });
    expect(resolveDiskQuery(rows, 'Turrican II disk 2')).toEqual({ kind: 'one', disk: rows[1] });
  });

  it('a bare, case-insensitive title substring across several disks is many', () => {
    const rows = [
      disk({ id: ID, title: 'Turrican II', diskNo: 1 }),
      disk({ id: ID2, title: 'Turrican II', diskNo: 2 }),
    ];
    expect(resolveDiskQuery(rows, 'turrican')).toEqual({ kind: 'many', disks: rows });
  });

  it('an exact, case-insensitive TOSEC name matches to one', () => {
    const rows = [
      disk({ id: ID, title: 'Turrican II', tosecName: 'Turrican II (1991)(Rainbow Arts).adf' }),
      disk({ id: ID2, title: 'Other Game' }),
    ];
    expect(resolveDiskQuery(rows, 'TURRICAN II (1991)(RAINBOW ARTS).ADF')).toEqual({ kind: 'one', disk: rows[0] });
  });

  it('an exact, case-insensitive source filename matches to one', () => {
    const rows = [
      disk({ id: ID, title: 'Turrican II', sourceFilename: 'turrican2_disk1.adf' }),
      disk({ id: ID2, title: 'Other Game' }),
    ];
    expect(resolveDiskQuery(rows, 'TURRICAN2_DISK1.ADF')).toEqual({ kind: 'one', disk: rows[0] });
  });

  it('no match at all is none', () => {
    const rows = [disk({ id: ID, title: 'Turrican II' })];
    expect(resolveDiskQuery(rows, 'nonexistent title')).toEqual({ kind: 'none' });
  });

  it('a query matching a title and a different disk\'s filename is many, never a guess', () => {
    const rows = [
      disk({ id: ID, title: 'Amberstar', sourceFilename: null }),
      disk({ id: ID2, title: 'Other Game', sourceFilename: 'AmberStar' }),
    ];
    expect(resolveDiskQuery(rows, 'amberstar')).toEqual({ kind: 'many', disks: rows });
  });
});
