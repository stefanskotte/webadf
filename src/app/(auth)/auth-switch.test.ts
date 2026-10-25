import { describe, it, expect } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { AuthSwitch } from './auth-switch';

describe('AuthSwitch (C5 spec §6.2, Ruling 31)', () => {
  it('is a nav of two links; only the current page is aria-current', () => {
    const html = renderToStaticMarkup(createElement(AuthSwitch, { current: 'up' }));
    expect(html).toContain('<nav aria-label="Account" data-testid="auth-switch"');
    expect(html).toMatch(/href="\/sign-in"[^>]*>Sign in</);
    expect(html).toMatch(/href="\/sign-up"[^>]*aria-current="page"|aria-current="page"[^>]*href="\/sign-up"/);
    expect(html.match(/aria-current="page"/g)?.length).toBe(1);
  });
});
