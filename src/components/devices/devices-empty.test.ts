import { describe, it, expect, vi } from 'vitest';

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: () => {} }) }));
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
    const sub = html.indexOf('Pairing links a board to this account. It takes five steps.');
    const steps = html.indexOf('data-testid="pairing-steps"');
    const btn = html.indexOf('data-testid="pair-another"');
    expect(svg).toBeGreaterThan(-1);
    expect(svg).toBeLessThan(head);
    expect(head).toBeLessThan(sub);
    expect(sub).toBeLessThan(steps);
    expect(steps).toBeLessThan(btn);
    expect(html).toContain('width="120" height="52"');
    expect(html).toContain('aria-hidden="true"');
  });

  it('starts the steps on this page: the code comes from here, and the setup page has an address', () => {
    expect(html).toContain('Get a pairing code here');
    expect(html).toContain('wififloppy');
    expect(html).toContain('http://192.168.4.1');
    expect(html).toContain('30 minutes');
  });

  it('keeps the button text', () => {
    expect(html).toMatch(/data-testid="pair-another"[^>]*>Pair a device</);
  });
});
