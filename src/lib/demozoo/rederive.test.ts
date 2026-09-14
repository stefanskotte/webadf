import { describe, it, expect } from 'vitest';
import { rederiveMachineTitle } from './rederive';

describe('rederiveMachineTitle — what a game falls back to after Unlink', () => {
  it('prefers the TOSEC identity', () => {
    expect(rederiveMachineTitle({ tosec: { title: 'Ray of Hope 2', year: 1991, publisher: 'Majic 12' }, filename: 'x.adf', fallbackTitle: 'x' }))
      .toEqual({ title: 'Ray of Hope 2', sortTitle: 'ray of hope 2', year: 1991, publisher: 'Majic 12', metadataSource: 'tosec' });
  });
  it('otherwise parses the uploaded filename, as ingest does', () => {
    expect(rederiveMachineTitle({ tosec: null, filename: 'covered-1.adf', fallbackTitle: 'Wayfarer' }))
      .toMatchObject({ title: 'covered', metadataSource: 'filename' });
  });
  it('uses the fallback only when there is no filename', () => {
    expect(rederiveMachineTitle({ tosec: null, filename: null, fallbackTitle: 'Some Disk' }))
      .toMatchObject({ title: 'Some Disk', metadataSource: 'filename' });
  });
});
