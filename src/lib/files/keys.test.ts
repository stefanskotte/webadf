import { describe, expect, it } from 'vitest';
import { commandFor, type FilesCommand } from './keys';

const ev = (key: string, o: Partial<Parameters<typeof commandFor>[0]> = {}) => ({
  key, target: { tagName: 'DIV' }, dialogOpen: false, altKey: false, ctrlKey: false, metaKey: false, ...o,
});

describe('commandFor', () => {
  const table: [string, FilesCommand][] = [
    ['ArrowUp', 'up'], ['ArrowDown', 'down'], [' ', 'pick'], ['Enter', 'open'], ['Backspace', 'parent'],
    ['Tab', 'switch'], ['F5', 'copy'], ['F6', 'move'], ['F7', 'makedir'], ['F2', 'rename'], ['Delete', 'delete'],
  ];
  for (const [key, cmd] of table) it(`${JSON.stringify(key)} is ${cmd}`, () => expect(commandFor(ev(key))).toBe(cmd));

  it('other keys are not commands', () => {
    expect(commandFor(ev('a'))).toBeNull();
    expect(commandFor(ev('F1'))).toBeNull();
  });
  it('a null target still works', () => expect(commandFor(ev('Enter', { target: null }))).toBe('open'));
  for (const tagName of ['INPUT', 'TEXTAREA', 'SELECT']) {
    it(`null inside ${tagName}`, () => expect(commandFor(ev('Delete', { target: { tagName } }))).toBeNull());
  }
  it('null inside contentEditable', () => {
    expect(commandFor(ev('Backspace', { target: { tagName: 'DIV', isContentEditable: true } }))).toBeNull();
  });
  it('null with a dialog open', () => expect(commandFor(ev('Enter', { dialogOpen: true }))).toBeNull());
  it('null with any of alt, ctrl, meta', () => {
    expect(commandFor(ev('F5', { ctrlKey: true }))).toBeNull();
    expect(commandFor(ev('F5', { altKey: true }))).toBeNull();
    expect(commandFor(ev('F5', { metaKey: true }))).toBeNull();
  });
  it("'/' finds; never while typing in a field", () => {
    const base = { target: { tagName: 'DIV' }, dialogOpen: false, altKey: false, ctrlKey: false, metaKey: false };
    expect(commandFor({ ...base, key: '/' })).toBe('find');
    expect(commandFor({ ...base, key: '/', target: { tagName: 'INPUT' } })).toBeNull();
    expect(commandFor({ ...base, key: '/', dialogOpen: true })).toBeNull();
  });
});
