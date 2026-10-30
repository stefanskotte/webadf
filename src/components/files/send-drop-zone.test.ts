import { describe, it, expect } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { SendTarget } from '@/lib/send-ui';
import { SendDropZone, sentReport } from './send-drop-zone';

const target = (id: string, name: string, o: Partial<SendTarget> = {}): SendTarget => ({
  id, name, macAddress: null, defaultName: false, online: true, lastSeenAt: 1000, network: true, rx: 'c', rxAt: 1000,
  firmwareVersion: '1.21.1+gabc', rxProto: null, browseOn: false, ...o,
});
const render = (targets: SendTarget[]) =>
  renderToStaticMarkup(createElement(SendDropZone, { targets, initialBoard: null, serverNow: 1000, onSent: () => {} }));

describe('SendDropZone markup', () => {
  it('with no board says so and links to Devices, as no drop target', () => {
    const h = render([]);
    expect(h).toContain('files-drop-send');
    expect(h).toContain('files-send-no-board');
    expect(h).toContain('href="/devices"');
    expect(h).toContain('data-drop="off"');
    expect(h).not.toContain('files-send-input');
  });
  it('with one board names it on a line', () => {
    const h = render([target('d1', 'A500 bench')]);
    expect(h).toContain('files-send-board"');
    expect(h).toContain('A500 bench');
    expect(h).toContain('files-send-input');
    expect(h).toContain('files-send-receiver');
    expect(h).not.toContain('files-send-board-picker');
  });
  it('with two boards offers a radio each', () => {
    const h = render([target('d1', 'A500 bench'), target('d2', 'A1200')]);
    expect(h).toContain('files-send-board-picker');
    expect(h).toContain('files-send-board-d1');
    expect(h).toContain('files-send-board-d2');
    expect(h).toContain('type="radio"');
  });
});

describe('sentReport', () => {
  it('counts a whole send', () => {
    expect(sentReport({ queued: 5, failed: [], stopped: null }, 5, 'A500 bench')).toMatchObject({ ok: true, title: 'Queued 5 files for A500 bench' });
    expect(sentReport({ queued: 1, failed: [], stopped: null }, 1, 'A500 bench').title).toBe('Queued 1 file for A500 bench');
  });
  it('says how far a stopped send got and why', () => {
    const r = sentReport({ queued: 3, failed: [], stopped: 'Signed out — sign in again' }, 5, 'A500 bench');
    expect(r).toEqual({ ok: false, title: 'Queued 3 of 5 for A500 bench — Signed out — sign in again', lines: [] });
  });
});
