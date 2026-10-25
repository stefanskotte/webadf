import { describe, it, expect } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { StagingRow } from './staging-row';
import { stagingView, type LibRow, type ServerRow } from '@/lib/upload-staging';

const amiga = (o: Partial<ServerRow>): ServerRow => ({ source: 'server', key: 'amiga:u1', kind: 'in', id: 'u1',
  name: 'DH0:Docs/Very/Long/Path/amiga-wb31_storage.adf', sizeBytes: 901_120, board: { id: 'd1', name: 'Bench' },
  status: 'receiving', doneBytes: 0, pct: 47, savedAs: null, error: null, isDiskImage: true, title: null, at: 1, ...o });
const lib = (o: Partial<LibRow>): LibRow => ({ source: 'lib', key: 'lib:abc', kind: 'lib', name: 'Bad.zip',
  sizeBytes: 1_000_000, state: 'failed', note: 'No disk images inside', title: null, at: 1, ...o });
const html = (r: ServerRow | LibRow) =>
  renderToStaticMarkup(createElement(StagingRow, { v: stagingView([r], 'all', new Set()).shown[0] }, 'ACTIONS'));

describe('StagingRow (spec §5)', () => {
  it('keeps the row attributes and every part id', () => {
    const h = html(amiga({}));
    expect(h).toMatch(/<li[^>]*data-testid="staging-row"[^>]*data-kind="in"[^>]*data-state="receiving"[^>]*data-key="amiga:u1"/);
    for (const id of ['staging-dir-amiga:u1', 'staging-where-amiga:u1', 'staging-size-amiga:u1',
      'staging-status-amiga:u1', 'staging-progress-amiga:u1', 'staging-actions-amiga:u1']) {
      expect(h).toContain(`data-testid="${id}"`);
    }
    expect(h).toContain('ACTIONS');
  });
  it('the pill says the direction with an aria-hidden arrow', () => {
    expect(html(amiga({}))).toMatch(/data-testid="staging-dir-amiga:u1"[^>]*><span aria-hidden="true">←<\/span>From Amiga</);
  });
  it('the progress bar is aria-hidden at the row percent, and absent without one', () => {
    expect(html(amiga({}))).toMatch(/data-testid="staging-progress-amiga:u1"[^>]*aria-hidden="true"|aria-hidden="true"[^>]*data-testid="staging-progress-amiga:u1"/);
    expect(html(amiga({}))).toContain('width:47%');
    expect(html(amiga({ status: 'stored', pct: null }))).not.toContain('staging-progress-');
  });
  it('the status holds only its words (a dot without text), and a refused library file keeps ingest-note', () => {
    const h = html(lib({}));
    expect(h).toMatch(/data-testid="staging-status-lib:abc"[^>]*>(<span aria-hidden="true"[^>]*><\/span>)?<span>Failed · <span data-testid="ingest-note">No disk images inside<\/span>/);
  });
  it('one line from xl, a three-line card below it; names wrap, never ellipsis', () => {
    const h = html(amiga({}));
    expect(h).toContain('xl:grid-cols-[40px_140px_minmax(0,1fr)_90px_190px_400px]');
    expect(h).toContain('grid-cols-[40px_minmax(0,1fr)_auto]');
    expect(h).not.toContain('text-ellipsis');
    expect(h).not.toContain('truncate');
    expect(h).toContain('overflow-wrap:anywhere');
  });
});
