import { describe, expect, it } from 'vitest';
import { browseBlock, errorWords } from './remote-browse';

const ok = { online: true, firmware: '1.22.0+gabc', rx: 'c', rxProto: 3, browseOn: true, name: 'A500', offlineWords: 'offline 3 h' };
describe('browseBlock', () => {
  it('is null when everything allows it', () => expect(browseBlock(ok)).toBeNull());
  it('names the first missing thing', () => {
    expect(browseBlock({ ...ok, online: false, firmware: '1.0.0' })).toBe('offline 3 h');
    expect(browseBlock({ ...ok, firmware: '1.21.1+gabc' })).toBe('Firmware 1.22 or newer is needed');
    expect(browseBlock({ ...ok, rx: 'u' })).toBe('Transfer is not running on A500');
    expect(browseBlock({ ...ok, rxProto: 2 })).toBe('Transfer 2.3 or newer is needed on A500');
    expect(browseBlock({ ...ok, browseOn: false })).toBe('Switch on browsing in Transfer on A500');
  });
});
describe('errorWords', () => {
  it('maps codes to the pane words', () => {
    expect(errorWords('off', '', 'A500')).toBe('Switch on browsing in Transfer on A500');
    expect(errorWords('notfound', 'object not found', 'A500')).toBe('Object not found');
    expect(errorWords('timeout', '', 'A500')).toBe("A500 didn't answer — Refresh to try again");
    expect(errorWords('busy', 'object in use', 'A500')).toBe('object in use');
    expect(errorWords('io', '', 'A500')).toBe('Failed');
  });
});
