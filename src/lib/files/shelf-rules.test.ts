import { describe, it, expect } from 'vitest';
import { collectionNameProblem, SHELF_WORDS, MAKEDIR_IN_DISK } from './shelf-rules';

describe('collection names (Files 2 R3: the Library\'s 1-80 characters, trimmed)', () => {
  it('refuses empty and over-long names, takes anything else', () => {
    expect(collectionNameProblem('   ')).toBe('empty');
    expect(collectionNameProblem('x'.repeat(81))).toBe('collection-too-long');
    expect(collectionNameProblem(`  ${'x'.repeat(80)}  `)).toBeNull();
    expect(collectionNameProblem('Demos: 1993/94')).toBeNull();
  });
});

describe('the words a shelf refusal carries (D13)', () => {
  it('a folder made in a title\'s disk list says where folders go, as a sentence of its own', () => {
    expect(MAKEDIR_IN_DISK).toBe('Open a disk or STASH: to make a folder in it');
    expect(SHELF_WORDS).toContain(MAKEDIR_IN_DISK);
  });
});
