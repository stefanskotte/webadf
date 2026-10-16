import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { newestRelease, completePackLink, AMIGA_ADF_DAT } from './tosec-fetch-parse';

const page = (f: string) => readFileSync(`src/lib/__fixtures__/${f}`, 'utf8');

describe('tosecdev.org pages', () => {
  it('finds the newest dated release on the downloads page', () => {
    expect(newestRelease(page('tosec-downloads.html'))).toEqual({ path: '/downloads/category/59-2025-03-13', date: '2025-03-13' });
  });
  it('picks by date, not by position or category number', () => {
    const html = '<a href="/downloads/category/9-2024-01-01">a</a><a href="/downloads/category/60-2023-05-05">b</a><a href="/downloads/category/22-datfiles">c</a>';
    expect(newestRelease(html)?.date).toBe('2024-01-01');
  });
  it('is null when no dated release is listed', () => { expect(newestRelease('<a href="/downloads/category/22-datfiles">x</a>')).toBeNull(); });
  it('finds the Complete pack link on a release page, absolute', () => {
    expect(completePackLink(page('tosec-release-2025-03-13.html')))
      .toBe('https://www.tosecdev.org/downloads/category/59-2025-03-13?download=117:tosec-dat-pack-complete-4743-tosec-v2025-03-13');
  });
  it('is null when the page has no Complete pack link', () => { expect(completePackLink('<a href="/x?download=1:other">x</a>')).toBeNull(); });
});

describe('AMIGA_ADF_DAT', () => {
  it.each([
    ['TOSEC/Commodore Amiga - Games - [ADF] (TOSEC-v2025-01-30_CM).dat', true],
    ['TOSEC/Commodore Amiga - Games - Public Domain - [ADF] (TOSEC-v2025-01-28_CM).dat', true],
    ['TOSEC/Commodore Amiga - Games - [IPF] (TOSEC-v2025-01-30_CM).dat', false],
    ['TOSEC/Commodore Amiga CD32 - Games - [ADF] (TOSEC-v2025-01-30_CM).dat', false],
    ['TOSEC-PIX/Commodore Amiga - Games - [ADF] (TOSEC-v2025-01-30_CM).dat', false],
    ['CUEs/Commodore/Amiga CD32/x.cue', false],
  ])('%s -> %s', (name, ok) => { expect(AMIGA_ADF_DAT.test(name)).toBe(ok); });
});
