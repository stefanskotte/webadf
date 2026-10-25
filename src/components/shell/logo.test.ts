import { describe, it, expect } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Logo } from './logo';

describe('Logo tone (C5 spec §6.1)', () => {
  it('dark (default): ink body, cream label -- the header and favicon mark, unchanged', () => {
    const html = renderToStaticMarkup(createElement(Logo, { size: 34 }));
    expect(html).toMatch(/<path d="M5 0 H88[^"]*" fill="#24211B"/);
    expect(html).toContain('fill="#FBF8F1"');
  });
  it('light: surface body, ink lower label, for the ink hero', () => {
    const html = renderToStaticMarkup(createElement(Logo, { size: 34, tone: 'light' }));
    expect(html).toMatch(/<path d="M5 0 H88[^"]*" fill="#FFFDF8"/);
    expect(html).toMatch(/<path d="M12 48[^"]*" fill="#24211B"/);
  });
});
