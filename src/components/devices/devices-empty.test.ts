import { describe, it, expect } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { PairingProvider } from './pairing';
import { DevicesEmpty } from './devices-empty';

const html = renderToStaticMarkup(createElement(PairingProvider, null, createElement(DevicesEmpty)));

describe('DevicesEmpty (spec 9.1)', () => {
  it('is the devices-empty card with data-empty', () => {
    expect(html).toContain('data-testid="devices-empty"');
    expect(html).toContain('data-empty="devices"');
    expect(html).toContain('1px dashed var(--line-strong)');
    expect(html).toContain('rounded-[20px]');
  });

  it('draws the outline first, then the words, then the button, in order', () => {
    const svg = html.indexOf('<svg');
    const head = html.indexOf('No devices paired yet');
    const sub = html.indexOf('Press Pair a device and enter the code on the board.');
    const btn = html.indexOf('data-testid="pair-another"');
    expect(svg).toBeGreaterThan(-1);
    expect(svg).toBeLessThan(head);
    expect(head).toBeLessThan(sub);
    expect(sub).toBeLessThan(btn);
    expect(html).toContain('width="120" height="52"');
    expect(html).toContain('aria-hidden="true"');
  });

  it('keeps the button text', () => {
    expect(html).toMatch(/data-testid="pair-another"[^>]*>Pair a device</);
  });
});
