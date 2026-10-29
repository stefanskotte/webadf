import { describe, it, expect } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Switch } from './switch';

describe('Switch', () => {
  it('is a button with role switch saying its state', () => {
    const on = renderToStaticMarkup(createElement(Switch, { checked: true, onChange() {}, testId: 's', 'aria-label': 'Show .info files' }));
    expect(on).toMatch(/^<button type="button" role="switch" aria-checked="true"/);
    expect(on).toContain('data-testid="s"');
    expect(renderToStaticMarkup(createElement(Switch, { checked: false, onChange() {}, testId: 's' }))).toContain('aria-checked="false"');
  });
});
