import { describe, it, expect } from 'vitest';
import { createAdfProblem } from './create-adf-dialog';

describe('Create ADF dialog (Files 2 §4, R6, R7)', () => {
  it('names follow the volume rules; with Ask, a <Name>.adf already in the folder is refused inline', () => {
    expect(createAdfProblem('Untitled', null)).toBeNull();
    expect(createAdfProblem('', null)).toBe('Type a name.');
    expect(createAdfProblem('a/b', null)).toBe('Names cannot contain : or /, or characters an Amiga cannot show.');
    expect(createAdfProblem('Work', ['work.ADF'])).toBe('Something with that name is already there.');
    expect(createAdfProblem('Work', ['Work.txt'])).toBeNull();
  });
  it('the name is trimmed, as the server trims it: " Work " is Work', () => {
    expect(createAdfProblem('   ', null)).toBe('Type a name.');
    expect(createAdfProblem(' Work ', ['Work.adf'])).toBe('Something with that name is already there.');
    expect(createAdfProblem(` ${'x'.repeat(30)} `, null)).toBeNull();
  });
});
