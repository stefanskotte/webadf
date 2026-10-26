import { describe, it, expect } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { AboutBone, AboutCard, AboutGroupsView } from './about-view';

const build = {
  commit: 'abc1234def', shortCommit: 'abc1234', commitUrl: 'https://github.com/stefanskotte/webadf/commit/abc1234def',
  builtAt: '2026-10-26T10:00:00.000Z', nextVersion: '16.3.2',
};
type ViewProps = Parameters<typeof AboutGroupsView>[0];
const view = (over: Partial<ViewProps> = {}) => renderToStaticMarkup(createElement(AboutGroupsView, {
  build, hosted: false, node: '22.0.0', storage: 'Local disk',
  usage: { ok: true, value: { titles: 2, disks: 3, versions: 4, bytes: 901120 } },
  firmware: { ok: true, value: { latest: { version: '1.21.1', sequence: 119 }, boards: 0, behind: 0 } },
  ...over,
}));

describe('AboutCard (C7 spec §10.1, Rulings 21, 24)', () => {
  const html = renderToStaticMarkup(createElement(AboutCard, null, 'BODY'));
  it('is section #about, labelled by its focusable heading, in the Settings card look', () => {
    expect(html).toMatch(/^<section id="about" aria-labelledby="about-heading" data-testid="settings-about" class="scroll-mt-6 rounded-\[20px\] p-5 sm:p-6"/);
    expect(html).toContain('<h2 id="about-heading" tabindex="-1"');
    expect(html).toContain('focus:outline-(--ring)');
    expect(html).toContain('>About this server</h2>');
    expect(html).toContain('data-testid="help-tip-about"');
    expect(html.indexOf('</h2>')).toBeLessThan(html.indexOf('BODY'));
  });
});

describe('AboutGroupsView', () => {
  it('keeps the six groups in order, with every id and word, as h3 groups split by hairlines, no glass cards', () => {
    const html = view();
    const ids = [...html.matchAll(/data-testid="about-(web-app|hosting|platform|firmware|library|about-webadf)"/g)].map((m) => m[1]);
    expect(ids).toEqual(['web-app', 'hosting', 'platform', 'firmware', 'library', 'about-webadf']);
    for (const w of ['Web app', 'Hosting', 'Platform', 'Board firmware', 'Your library', 'WebFloppy', 'Self-hosted',
      'Node.js 22.0.0', 'Next.js 16.3.2', 'PostgreSQL', 'Local disk', 'MIT', 'Repository', '1.21.1 (sequence 119)',
      'No boards paired', 'An Amiga floppy library that mounts disks on real Amigas over Wi-Fi.']) {
      expect(html, w).toContain(w);
    }
    expect(html).toContain('data-testid="about-commit"');
    expect(html).toContain('href="https://github.com/stefanskotte/webadf/commit/abc1234def"');
    expect(html).toContain('data-testid="about-hosting-mode"');
    expect(html).toContain('data-testid="about-library-bytes" data-bytes="901120"');
    for (const id of ['titles', 'disks', 'versions']) expect(html).toContain(`data-testid="about-library-${id}"`);
    expect(html.match(/<h3 /g)?.length).toBe(6);
    expect(html.match(/border-t pt-4/g)?.length).toBe(5);
    expect(html).not.toContain('glass-card');
  });
  it('reads Hosted when hosted', () => {
    expect(view({ hosted: true })).toContain('Hosted (webadf.vercel.app)');
  });
  it('a failed read blanks only its own group', () => {
    const html = view({ usage: { ok: false }, firmware: { ok: false } });
    expect(html.match(/>unavailable</g)?.length).toBe(2);
    expect(html).toContain('data-testid="about-web-app"');
    expect(html).not.toContain('about-library-titles');
  });
});

describe('AboutBone', () => {
  it('is an aria-hidden column of bones', () => {
    const html = renderToStaticMarkup(createElement(AboutBone));
    expect(html).toMatch(/^<div data-about-bone="" aria-hidden="true"/);
    expect(html.match(/motion-safe:animate-pulse/g)?.length).toBe(6);
  });
});
