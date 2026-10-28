import { describe, it, expect } from 'vitest';
import { remoteAddUrl } from './landing';

const LINK = 'https://owner.example/s/wfsc_' + 'A'.repeat(43) + '#pin=' + 'P'.repeat(43);
const ENC = encodeURIComponent(LINK);

describe('remoteAddUrl', () => {
  it('a bare host gets https', () => {
    expect(remoteAddUrl('floppy.lan', LINK)).toBe(`https://floppy.lan/remote/add#link=${ENC}`);
  });
  it('keeps scheme and port, drops path and trailing slash', () => {
    expect(remoteAddUrl('  http://192.168.1.20:8080/library/ ', LINK)).toBe(`http://192.168.1.20:8080/remote/add#link=${ENC}`);
  });
  it('encodes the whole link, fragment included', () => {
    expect(remoteAddUrl('https://me.example', LINK)).toContain('%23pin%3D');
  });
  it('refuses empty, other schemes, credentials', () => {
    expect(remoteAddUrl('   ', LINK)).toBeNull();
    expect(remoteAddUrl('javascript://alert(1)', LINK)).toBeNull();
    expect(remoteAddUrl('ftp://x.example', LINK)).toBeNull();
    expect(remoteAddUrl('https://u:p@x.example', LINK)).toBeNull();
  });
});
