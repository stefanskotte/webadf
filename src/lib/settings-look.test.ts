import { describe, it, expect } from 'vitest';
import { radioAfterKey, prefsStateLook } from '@/lib/settings-look';

const V = ['library', 'devices', 'upload'] as const;

describe('radioAfterKey (C5 spec §1.1)', () => {
  it('arrows move and wrap; Home and End jump', () => {
    expect(radioAfterKey(V, 'library', 'ArrowRight')).toBe('devices');
    expect(radioAfterKey(V, 'library', 'ArrowDown')).toBe('devices');
    expect(radioAfterKey(V, 'upload', 'ArrowRight')).toBe('library');
    expect(radioAfterKey(V, 'library', 'ArrowLeft')).toBe('upload');
    expect(radioAfterKey(V, 'devices', 'ArrowUp')).toBe('library');
    expect(radioAfterKey(V, 'devices', 'Home')).toBe('library');
    expect(radioAfterKey(V, 'devices', 'End')).toBe('upload');
  });
  it('ignores other keys and any key with Alt, Ctrl or Meta', () => {
    expect(radioAfterKey(V, 'library', 'Enter')).toBeNull();
    expect(radioAfterKey(V, 'library', ' ')).toBeNull();
    expect(radioAfterKey(V, 'library', 'ArrowRight', { alt: true })).toBeNull();
    expect(radioAfterKey(V, 'library', 'Home', { ctrl: true })).toBeNull();
    expect(radioAfterKey(V, 'library', 'End', { meta: true })).toBeNull();
  });
  it('a value outside the list starts from the first (forward) or the last (back)', () => {
    expect(radioAfterKey(V, 'nope' as never, 'ArrowRight')).toBe('library');
    expect(radioAfterKey(V, 'nope' as never, 'ArrowLeft')).toBe('upload');
    expect(radioAfterKey([] as string[], 'x', 'ArrowRight')).toBeNull();
  });
});

describe('prefsStateLook (spec §2.2, Ruling 7)', () => {
  it("keeps A2's three words, each with its dot and colour", () => {
    expect(prefsStateLook('saved')).toEqual({ text: 'All changes saved', dot: 'var(--online-dot)', fg: 'var(--success-fg)' });
    expect(prefsStateLook('saving')).toEqual({ text: 'Saving…', dot: 'var(--fetch-dot)', fg: 'var(--muted)' });
    expect(prefsStateLook('failed')).toEqual({ text: "Couldn't save. Try again", dot: 'var(--danger-fg)', fg: 'var(--danger-fg)' });
  });
});
