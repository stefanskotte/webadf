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

  it('is the round track button with a text "?", 24 px, ink when open (C5 spec §4.1, Ruling 18)', () => {
    const html = renderToStaticMarkup(createElement(HelpTip, { topic: 'display' }));
    expect(html).toContain('size-6');
    expect(html).toContain('rounded-full');
    expect(html).toContain('bg-(--track)');
    expect(html).toContain('data-[popup-open]:bg-(--ink)');
    expect(html).toMatch(/<span aria-hidden="true">\?<\/span>/);
    expect(html).not.toContain('<svg');
    expect(html).toContain('aria-label="About The board&#x27;s display"');
  });

  it('on an ink bar it turns the on-ink fill with an outline when hovered or open, never ink on ink (Task 8 review)', () => {
    const html = renderToStaticMarkup(createElement(HelpTip, { topic: 'files', onInk: true }));
    expect(html).toContain('bg-(--track)');
    expect(html).toContain('hover:bg-(--on-ink-fill)');
    expect(html).toContain('data-[popup-open]:bg-(--on-ink-fill)');
    expect(html).toContain('data-[popup-open]:ring-(--on-ink-muted)');
    expect(html).not.toContain('hover:bg-(--ink)');
    expect(html).not.toContain('data-[popup-open]:bg-(--ink)');
  });
});
