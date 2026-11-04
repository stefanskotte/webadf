import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { sysconfDefaults } from '@/lib/files/sysconf';
import { paint } from './pointer-editor';
import { colorToCss, cssToColor, draftOf, settingsOf, SysconfFooter, SysconfForm } from './sysconf-dialog';

const noop = () => {};
const form = () => createElement(SysconfForm, { formId: 'f', draft: draftOf(sysconfDefaults()), onChange: noop, onSubmit: noop });
const footer = (clash: boolean) => createElement(SysconfFooter, {
  formId: 'f', busy: false, clash, settings: sysconfDefaults(), problem: null, onClash: noop, onBack: noop, onCancel: noop,
});

describe('the draft', () => {
  it('the defaults round-trip', () => expect(settingsOf(draftOf(sysconfDefaults()))).toEqual({ settings: sysconfDefaults() }));
  it('shows seconds to two places', () => expect(draftOf(sysconfDefaults()).keyDelay).toBe('0.60'));
  it('reads typed seconds as whole microseconds', () => {
    const r = settingsOf({ ...draftOf(sysconfDefaults()), keyDelay: '1.5' });
    expect('settings' in r && r.settings.keyDelayUs).toBe(1500000);
    const f = settingsOf({ ...draftOf(sysconfDefaults()), keySpeed: '0.07' });
    expect('settings' in f && f.settings.keySpeedUs).toBe(70000);      // never 70000.00000000001
  });
  it.each(['', 'abc', '1,5', '-1', 'Infinity', '0.01', '3'])('a key delay of %j has a problem naming the field', (v) => {
    const r = settingsOf({ ...draftOf(sysconfDefaults()), keyDelay: v });
    expect('problem' in r && r.problem).toMatch(/Key repeat delay/);
  });
  it.each(['17', '', 'abc', '1.5'])('an overscan position of %j has a problem naming the field', (v) => {
    const r = settingsOf({ ...draftOf(sysconfDefaults()), viewX: v });
    expect('problem' in r && r.problem).toMatch(/Overscan position/);
  });
  it('overscan size takes 64 and refuses 65', () => {
    expect(settingsOf({ ...draftOf(sysconfDefaults()), extraColumns: '64' })).toHaveProperty('settings');
    const r = settingsOf({ ...draftOf(sysconfDefaults()), extraColumns: '65' });
    expect('problem' in r && r.problem).toMatch(/Overscan size/);
  });
  it('a negative overscan is typed as one', () => {
    const r = settingsOf({ ...draftOf(sysconfDefaults()), viewY: '-3' });
    expect('settings' in r && r.settings.viewY).toBe(-3);
  });
});

describe('colours', () => {
  it('maps 12-bit colours to CSS and back', () => {
    expect(colorToCss(0x68B)).toBe('#6688bb');
    expect(cssToColor('#6688bb')).toBe(0x68B);
    expect(cssToColor('#000000')).toBe(0);
    expect(cssToColor('#ffffff')).toBe(0xFFF);
  });
  it('rounds a colour between two Amiga colours to the nearer', () => expect(cssToColor('#090000')).toBe(0x100));
});

describe('the pointer', () => {
  it('paint changes one cell, in a new array', () => {
    const before = sysconfDefaults().pointer;
    const after = paint(before, 2, 1, 'R');
    expect(after[1]).toBe('KWR.............');
    expect(after[0]).toBe(before[0]);
    expect(before[1]).toBe('KWK.............');
  });
});

describe('the dialog', () => {
  it('shows every group, with no serial or printer settings', () => {
    const html = renderToStaticMarkup(form());
    for (const w of ['Display', 'Overscan position', 'Overscan size', 'Workbench colours', 'Pointer', 'Keyboard and mouse', 'read at boot only', 'Devs']) expect(html).toContain(w);
    expect(html).not.toMatch(/serial|printer|baud/i);
  });
  it('the footer says the size', () => expect(renderToStaticMarkup(footer(false))).toContain('232 bytes'));
  it('the clash state offers Replace, Keep both and Skip', () => {
    const html = renderToStaticMarkup(footer(true));
    for (const t of ['files-sysconf-replace', 'files-sysconf-keep-both', 'files-sysconf-skip', 'files-sysconf-back']) expect(html).toContain(t);
    expect(html).toContain('already here');
  });
});
