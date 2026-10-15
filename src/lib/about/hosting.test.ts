import { describe, it, expect } from 'vitest';
import { hostingMode } from './hosting';

describe('hostingMode', () => {
  it.each([
    ['false', 'hosted'],
    [undefined, 'self-hosted'],
    ['', 'self-hosted'],
    ['true', 'self-hosted'],
    ['False', 'self-hosted'],
    ['FALSE', 'self-hosted'],
    [' false', 'self-hosted'],
    ['0', 'self-hosted'],
  ] as const)('SELFHOSTED=%j -> %s', (raw, want) => {
    expect(hostingMode(raw)).toBe(want);
  });
});
