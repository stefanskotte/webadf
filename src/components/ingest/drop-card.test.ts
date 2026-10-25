import { describe, it, expect } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { DropCard } from './drop-card';

const render = (p: Partial<Parameters<typeof DropCard>[0]> = {}) => renderToStaticMarkup(createElement(DropCard, {
  testId: 'dropzone', headingId: 'add-heading', title: 'Add disks to the library', hint: 'A hint.',
  disk: { color: 'black', set: 'ADF · ADZ · DMS · HFE', title: 'Add to library' }, onFiles: () => undefined,
  ...p }, createElement('span', null, 'controls')));

describe('DropCard (spec §2)', () => {
  it('is a labelled section carrying the drop id and data-over', () => {
    const html = render();
    expect(html).toMatch(/<section[^>]*aria-labelledby="add-heading"/);
    expect(html).toMatch(/<section[^>]*data-testid="dropzone"/);
    expect(html).toMatch(/<section[^>]*data-over="false"/);
    expect(html).toContain('id="add-heading"');
    expect(html).toContain('var(--dash)');
  });
  it('orders disk, heading, hint, controls', () => {
    const html = render();
    const at = (s: string) => html.indexOf(s);
    expect(at('<svg')).toBeLessThan(at('Add disks to the library'));
    expect(at('Add disks to the library')).toBeLessThan(at('A hint.'));
    expect(at('A hint.')).toBeLessThan(at('controls'));
  });
  it('without onFiles it is not a drop target', () => {
    expect(render({ onFiles: undefined })).toMatch(/<section[^>]*data-drop="off"/);
  });
});
