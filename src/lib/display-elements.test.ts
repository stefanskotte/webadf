import { describe, expect, it } from 'vitest';
import { ELEMENT_NAMES } from './display-layout';
import { ELEMENT_LOOK } from './display-elements';

describe('ELEMENT_LOOK (spec §10.3)', () => {
  it('has a label and a hint for every element', () => {
    for (const n of ELEMENT_NAMES) {
      expect(ELEMENT_LOOK[n].label.length).toBeGreaterThan(0);
      expect(ELEMENT_LOOK[n].hint.length).toBeGreaterThan(0);
    }
    expect(Object.keys(ELEMENT_LOOK).sort()).toEqual([...ELEMENT_NAMES].sort());
  });
  it('uses the specced words', () => {
    expect(ELEMENT_LOOK.status).toEqual({ label: 'Status', hint: 'READY, LOADING, LOADED — or an icon' });
    expect(ELEMENT_LOOK.wifi).toEqual({ label: 'Wi-Fi', hint: 'Signal bars, top left' });
    expect(ELEMENT_LOOK.track.hint).toBe('Head position, e.g. 42↑79');
    expect(ELEMENT_LOOK.nfc).toEqual({ label: 'NFC', hint: 'Reader icon, struck when none is found' });
  });
});
