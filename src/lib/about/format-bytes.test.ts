import { describe, it, expect } from 'vitest';
import { formatBytes } from './format-bytes';

describe('formatBytes', () => {
  it.each([
    [0, '0 B'], [512, '512 B'], [901_120, '880 KB'], [1_802_240, '1.7 MB'],
    [52_428_800, '50 MB'], [3_221_225_472, '3.0 GB'],
  ])('%d -> %s', (n, want) => expect(formatBytes(n)).toBe(want));
});
