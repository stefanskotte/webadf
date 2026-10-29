import { describe, it, expect } from 'vitest';
import { upsertLibRows, type LibRow } from './rows';

// Moved from upload-staging.test.ts when the Upload page's Staging list retired (Files increment 3).
const lib = (o: Partial<LibRow>): LibRow => ({ source: 'lib', key: 'lib:1', kind: 'lib', name: 'a.adf', sizeBytes: 901_120,
  state: 'hashing', title: null, at: 500, ...o });

describe('upsertLibRows', () => {
  it('replaces in place and appends new', () => {
    const out = upsertLibRows([lib({ key: 'lib:1' }), lib({ key: 'lib:2' })],
      [lib({ key: 'lib:1', state: 'done' }), lib({ key: 'lib:3' })]);
    expect(out.map((r) => [r.key, r.state])).toEqual([['lib:1', 'done'], ['lib:2', 'hashing'], ['lib:3', 'hashing']]);
  });
});
