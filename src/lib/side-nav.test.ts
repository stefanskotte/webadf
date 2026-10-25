import { describe, it, expect } from 'vitest';
import { currentSection } from '@/lib/side-nav';

const IDS = ['prefs', 'account', 'firmware', 'danger'];

describe('currentSection (C5 spec §1.2, Ruling 2)', () => {
  it('before any scroll: the hash target, else the first', () => {
    expect(currentSection(IDS, null, '#firmware')).toBe('firmware');
    expect(currentSection(IDS, null, 'firmware')).toBe('firmware');
    expect(currentSection(IDS, null, '')).toBe('prefs');
    expect(currentSection(IDS, null, '#about')).toBe('prefs');
  });
  it('after a scroll: the topmost section in view, in list order', () => {
    expect(currentSection(IDS, new Set(['danger', 'account']), '#prefs')).toBe('account');
    expect(currentSection(IDS, new Set(['firmware']), '')).toBe('firmware');
  });
  it('nothing in view keeps what was current (null); an empty list has none', () => {
    expect(currentSection(IDS, new Set(), '#danger')).toBeNull();
    expect(currentSection([], null, '#x')).toBeNull();
  });
});
