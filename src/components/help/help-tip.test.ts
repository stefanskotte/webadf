import { describe, it, expect } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { HelpTip } from './help-tip';

describe('HelpTip', () => {
  it('draws the "?" at full strength: faded on muted text it fell below 3:1 contrast', () => {
    const html = renderToStaticMarkup(createElement(HelpTip, { topic: 'display' }));
    expect(html).toContain('data-testid="help-tip-display"');
    expect(html).not.toMatch(/\bopacity-\d+\b/);
  });
});
