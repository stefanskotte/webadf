import { describe, it, expect } from 'vitest';
import { sel1Text, df1SeenText } from './second-drive';

describe('second-drive readings', () => {
  it('names both values of the SEL1 line', () => {
    expect(sel1Text(true)).toBe('DF1 line: connected');
    expect(sel1Text(false)).toBe('DF1 line: no signal yet');
  });
  it('names both values of the other-drive check', () => {
    expect(df1SeenText(true)).toBe('Other DF1 drive: detected');
    expect(df1SeenText(false)).toBe('Other DF1 drive: none seen');
  });
});
