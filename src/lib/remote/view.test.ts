import { describe, it, expect } from 'vitest';
import type { ShareTitle } from '@/lib/share/types';
import { addConfirmText, shareLinkHost, remoteHref, remoteListItem, remoteTitleHref, remoteDiskHref, remoteView } from './view';

const t: ShareTitle = {
  id: 't1', title: 'Lemmings', year: 1991, publisher: 'Psygnosis', kind: 'Game', diskCount: 2,
  hasCover: true, coverDigest: 'abc123', collectionIds: ['c1'],
};

describe('remoteListItem', () => {
  it("shapes an owner's title for the library's Cover and byline", () => {
    const g = remoteListItem(t, 'lib1');
    expect(g).toMatchObject({
      id: 't1', title: 'Lemmings', year: 1991, publisher: 'Psygnosis', kind: 'Game', diskCount: 2,
      authored: false, hasHd: false, hasHfe: false,
      coverUrl: '/api/remote/lib1/covers/t1?v=abc123',
    });
  });
  it('no cover: null, so the disk stands in', () => {
    expect(remoteListItem({ ...t, hasCover: false, coverDigest: null }, 'lib1').coverUrl).toBeNull();
  });
  it('a cover with no digest still has a url', () => {
    expect(remoteListItem({ ...t, coverDigest: null }, 'lib1').coverUrl).toBe('/api/remote/lib1/covers/t1');
  });
  it('ids are encoded into the path', () => {
    expect(remoteListItem({ ...t, id: 'a/b' }, 'l 1').coverUrl).toBe('/api/remote/l%201/covers/a%2Fb?v=abc123');
  });
});

describe('remoteView', () => {
  it('reads collection, q, cursor and view from the address, dropping junk', () => {
    expect(remoteView({ collection: 'c1', q: ' lem ', cursor: 'xyz', view: 'table' }))
      .toEqual({ collection: 'c1', q: 'lem', cursor: 'xyz', view: 'table' });
    expect(remoteView({})).toEqual({ collection: null, q: '', cursor: null, view: 'grid' });
    expect(remoteView({ collection: ['a', 'b'], view: 'list', q: 'x'.repeat(300) }))
      .toEqual({ collection: null, q: 'x'.repeat(100), cursor: null, view: 'grid' });
  });
});

describe('remoteHref', () => {
  it('the library, with only what is set', () => {
    expect(remoteHref('lib1', {})).toBe('/remote/lib1');
    expect(remoteHref('lib1', { collection: 'c1', q: 'lem', view: 'table', cursor: 'n' }))
      .toBe('/remote/lib1?collection=c1&q=lem&view=table&cursor=n');
    expect(remoteHref('lib1', { view: 'grid', q: '' })).toBe('/remote/lib1');
  });
  it('a title and a disk', () => {
    expect(remoteTitleHref('lib1', 't1')).toBe('/remote/lib1/titles/t1');
    expect(remoteDiskHref('lib1', 'd1', 't1')).toBe('/remote/lib1/disks/d1?title=t1');
  });
});

describe('shareLinkHost', () => {
  const CODE = `wfsc_${'A'.repeat(43)}`;
  it('the owner host of a link, plain, padded, http or wrapped in /remote/add#link=', () => {
    expect(shareLinkHost(`https://floppy.example/s/${CODE}`)).toBe('floppy.example');
    expect(shareLinkHost(`  https://floppy.example:8443/s/${CODE}/ `)).toBe('floppy.example:8443');
    expect(shareLinkHost(`http://192.168.1.20/s/${CODE}`)).toBe('192.168.1.20');
    expect(shareLinkHost(`https://mine.example/remote/add#link=${encodeURIComponent(`https://floppy.example/s/${CODE}`)}`)).toBe('floppy.example');
  });
  it('null for what is not a share link', () => {
    expect(shareLinkHost('https://floppy.example/s/nope')).toBeNull();
    expect(shareLinkHost('hello')).toBeNull();
  });
  it('the question', () => expect(addConfirmText('floppy.example')).toBe('Add the library shared from floppy.example?'));
});
