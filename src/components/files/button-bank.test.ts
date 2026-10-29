import { describe, it, expect } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { BANK_GRID, type BankCommand } from '@/lib/files/bank';
import { ButtonBank } from './button-bank';

const noop = () => {};
const none = Object.fromEntries(BANK_GRID.filter((c): c is BankCommand => c !== null).map((c) => [c, null])) as Record<BankCommand, string | null>;
const render = (reasons: Partial<Record<BankCommand, string | null>>, busy = false) => renderToStaticMarkup(createElement(ButtonBank, {
  device: 'LIBRARY', reasons: { ...none, ...reasons }, busy, showInfo: true, primaryCopy: false, onDevice: noop, onCommand: noop,
}));
const tagOf = (html: string, testid: string) => html.match(new RegExp(`<[a-z]+\\b[^>]*data-testid="${testid}"[^>]*>`))?.[0];
const attr = (tag: string, name: string) => tag.match(new RegExp(`\\b${name}="([^"]*)"`))?.[1];

describe('ButtonBank (Files 2 §2.3)', () => {
  it('a command that cannot apply is aria-disabled, and a screen reader hears why (not only a tooltip)', () => {
    const html = render({ rename: 'Select one item to rename it' });
    const b = tagOf(html, 'files-rename')!;
    expect(attr(b, 'aria-disabled')).toBe('true');
    // Not `disabled`: it stays focusable and a click or Enter says the reason (the manager toasts it).
    expect(b).not.toMatch(/\sdisabled(=|\s|>)/);
    expect(attr(b, 'title')).toBe('Select one item to rename it');
    const id = attr(b, 'aria-describedby')!;
    expect(id).toBeTruthy();
    expect(html).toMatch(new RegExp(`id="${id}"[^>]*>Select one item to rename it<`));
  });
  it('a command that applies carries neither', () => {
    const b = tagOf(render({}), 'files-info')!;
    expect(attr(b, 'aria-disabled')).toBeUndefined();
    expect(attr(b, 'aria-describedby')).toBeUndefined();
  });
  it('while an operation runs every command is aria-disabled', () => {
    expect(attr(tagOf(render({}, true), 'files-info')!, 'aria-disabled')).toBe('true');
  });
  it('the device column: STASH:, LIBRARY:, NET:, the source pane\'s pressed', () => {
    const html = render({});
    expect([...html.matchAll(/data-testid="files-dev-([A-Z]+)"/g)].map((m) => m[1])).toEqual(['STASH', 'LIBRARY', 'NET']);
    expect(attr(tagOf(html, 'files-dev-LIBRARY')!, 'aria-pressed')).toBe('true');
  });
});
