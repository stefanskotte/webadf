import { describe, it, expect } from 'vitest';
import { DISK_BODIES, diskIconMetrics } from './disk-icon';

describe('diskIconMetrics', () => {
  it('matches the board at 160 px (its default)', () => {
    expect(diskIconMetrics(160)).toEqual({
      w: 160, h: 163, showText: true, pad: 8, gap: 4, setSize: 9, titleSize: 16.8, badgeSize: 11,
      shadowY: 8, shadowBlur: 13,
    });
  });

  it('matches the board at 96 px (the empty library)', () => {
    expect(diskIconMetrics(96)).toEqual({
      w: 96, h: 98, showText: true, pad: 5, gap: 2, setSize: 7, titleSize: 10.1, badgeSize: 9,
      shadowY: 5, shadowBlur: 8,
    });
  });

  it('clamps every size to its floor at 24 px and drops the label text', () => {
    expect(diskIconMetrics(24)).toEqual({
      w: 24, h: 24, showText: false, pad: 3, gap: 2, setSize: 7, titleSize: 9, badgeSize: 9,
      shadowY: 1, shadowBlur: 2,
    });
  });

  it('shows the label text from 72 px up', () => {
    expect(diskIconMetrics(72).showText).toBe(true);
    expect(diskIconMetrics(71).showText).toBe(false);
  });
});

describe('DISK_BODIES', () => {
  it('has the six board colours, body and back', () => {
    expect(Object.keys(DISK_BODIES).sort()).toEqual(['black', 'blue', 'cream', 'green', 'grey', 'red']);
    expect(DISK_BODIES.cream).toEqual({ body: '#E2D9C6', back: '#C4B9A2' });
    expect(DISK_BODIES.black).toEqual({ body: '#232326', back: '#3A3A3F' });
    expect(DISK_BODIES.blue).toEqual({ body: '#2F5D9A', back: '#1F416E' });
    expect(DISK_BODIES.grey).toEqual({ body: '#8A8D93', back: '#6B6E74' });
    expect(DISK_BODIES.red).toEqual({ body: '#B23A2E', back: '#7E2920' });
    expect(DISK_BODIES.green).toEqual({ body: '#2F6B4F', back: '#204B37' });
  });
});
