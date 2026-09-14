import { describe, it, expect } from 'vitest';
import { titleKey } from './title-key';

describe('titleKey', () => {
  it('is the spike normaliser: lowercase, one leading article, alphanumerics only', () => {
    expect(titleKey('State of the Art')).toBe('stateoftheart');
    expect(titleKey('state-of-the-art')).toBe('stateoftheart');
    expect(titleKey('The Dreamland Megademo')).toBe('dreamlandmegademo');
    expect(titleKey('Alien Breed II: The Horror Continues')).toBe('alienbreediithehorrorcontinues');
    expect(titleKey('9 Fingers')).toBe('9fingers');
  });
  it('strips only ONE leading article', () => expect(titleKey('A The')).toBe('the'));
  it('returns empty for punctuation-only titles', () => expect(titleKey('!!!')).toBe(''));
});
