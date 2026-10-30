import { describe, it, expect } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { DropCard } from './drop-card';

const render = (p: Partial<Parameters<typeof DropCard>[0]> = {}) => renderToStaticMarkup(createElement(DropCard, {
  testId: 'dropzone', headingId: 'add-heading', title: 'Add disks to the library', hint: 'A hint. A second sentence.',
  disk: { color: 'black', set: 'ADF · ADZ · DMS · HFE', title: 'Add to library' }, onFiles: () => undefined, tileCol: 1,
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

describe('DropCard below sm (C7 spec §7, Ruling 19)', () => {
  it('the section is display:contents on a phone and a group for the drag look', () => {
    expect(render()).toMatch(/<section[^>]*class="group [^"]*max-sm:contents/);
  });
  it('the heading stays in the DOM for aria-labelledby, visually hidden on a phone', () => {
    expect(render()).toMatch(/<h2 id="add-heading" class="[^"]*max-sm:sr-only/);
  });
  it('the 34 px disk sits in the tile cell of its column, under the label (no pointer events)', () => {
    expect(render({ tileCol: 2 })).toMatch(/<span aria-hidden="true" class="[^"]*pointer-events-none[^"]*max-sm:col-start-2 max-sm:row-start-1[^"]*sm:hidden"/);
  });
  it('a phone keeps the first sentence of the hint; the rest is there from sm, and only for a screen reader from lg', () => {
    const html = render();
    expect(html).toContain('data-testid="dropzone-hint"');
    expect(html).toContain('A hint.<span class="max-sm:hidden lg:sr-only"> A second sentence.</span>');
  });
});

describe('DropCard from lg: a compact strip (Files 2 §2, the approved mock-up; Task 8 round 1)', () => {
  it('drops the 84 px disk, tightens the card and the heading, and puts the controls beside the words', () => {
    const html = render();
    expect(html).toMatch(/<section[^>]*class="[^"]*lg:px-4 lg:py-2/);
    expect(html).toContain('<span class="hidden shrink-0 sm:block lg:hidden">');
    expect(html).toMatch(/<h2 id="add-heading" class="[^"]*lg:text-\[16px\]/);
    expect(html).toMatch(/class="flex min-w-0 flex-1 flex-col gap-2 max-sm:contents lg:flex-row/);
  });
});
