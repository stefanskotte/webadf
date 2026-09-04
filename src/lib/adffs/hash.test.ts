import { it, expect } from 'vitest';
import { nameHash } from './hash';

it('hashes into the 72-slot table', () => {
  expect(nameHash('hello.txt', false)).toBeGreaterThanOrEqual(0);
  expect(nameHash('hello.txt', false)).toBeLessThan(72);
});

it('is case-insensitive, which is why a rename can change buckets', () => {
  expect(nameHash('README', false)).toBe(nameHash('readme', false));
});

it('INTL folds the extended Latin range and plain mode does not', () => {
  // 0xE9 is é. Under INTL it upper-cases to 0xC9 and hashes differently.
  expect(nameHash('café', true)).not.toBe(nameHash('café', false));
});
