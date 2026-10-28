import { describe, it, expect } from 'vitest';
import { mountFailureText, mountRequest, type RemoteMount } from './mount-request';

const df1 = (isThisDisk: boolean) => ({ enabled: true, isThisDisk, reason: null }) as never;
const mount = { id: 'dev1', action: 'mount' as const, revertDiskId: null, df1: null };
const eject = { id: 'dev1', action: 'eject' as const, revertDiskId: null, df1: null };
const cancel = { id: 'dev1', action: 'eject' as const, revertDiskId: 'other', df1: null };
const remote: RemoteMount = { libraryId: 'lib 1', titleId: 't1', diskId: 'd1', host: 'floppy.example' };
const body = (init: RequestInit) => JSON.parse(init.body as string);

describe('mountRequest without remote: the local routes, unchanged', () => {
  it('DF0 mount', () => {
    const r = mountRequest(mount, 'd1');
    expect(r.url).toBe('/api/devices/dev1/mount');
    expect(body(r.init)).toEqual({ diskId: 'd1' });
    expect(r).toMatchObject({ ejecting: false, viaRemote: false });
  });
  it('DF0 eject posts no body', () => {
    const r = mountRequest(eject, 'd1');
    expect(r.url).toBe('/api/devices/dev1/eject');
    expect(r.init).toEqual({ method: 'POST' });
    expect(r.ejecting).toBe(true);
  });
  it('a Cancel re-asks for the confirmed disk', () => {
    const r = mountRequest(cancel, 'd1');
    expect(r.url).toBe('/api/devices/dev1/mount');
    expect(body(r.init)).toEqual({ diskId: 'other' });
  });
  it('DF1 mount and DF1 eject', () => {
    expect(body(mountRequest({ ...mount, df1: df1(false) }, 'd1', 'df1').init)).toEqual({ diskId: 'd1', drive: 'df1' });
    const e = mountRequest({ ...mount, df1: df1(true) }, 'd1', 'df1');
    expect(e.url).toBe('/api/devices/dev1/eject');
    expect(body(e.init)).toEqual({ drive: 'df1' });
    expect(e).toMatchObject({ ejecting: true, df1Eject: true });
  });
});

describe('mountRequest with remote', () => {
  it('DF0 mount goes to the remote route with {titleId, deviceId, drive}', () => {
    const r = mountRequest(mount, 'd1', 'df0', remote);
    expect(r.url).toBe('/api/remote/lib%201/disks/d1/mount');
    expect(r.init.method).toBe('POST');
    expect(body(r.init)).toEqual({ titleId: 't1', deviceId: 'dev1', drive: 'df0' });
    expect(r.viaRemote).toBe(true);
  });
  it('DF1 mount too', () => {
    expect(body(mountRequest({ ...mount, df1: df1(false) }, 'd1', 'df1', remote).init))
      .toEqual({ titleId: 't1', deviceId: 'dev1', drive: 'df1' });
  });
  it('ejects and a Cancel re-ask keep the device routes', () => {
    expect(mountRequest(eject, 'd1', 'df0', remote)).toMatchObject({ url: '/api/devices/dev1/eject', viaRemote: false });
    expect(mountRequest(cancel, 'd1', 'df0', remote)).toMatchObject({ url: '/api/devices/dev1/mount', viaRemote: false });
    expect(mountRequest({ ...mount, df1: df1(true) }, 'd1', 'df1', remote)).toMatchObject({ url: '/api/devices/dev1/eject', viaRemote: false });
  });
});

describe('mountFailureText', () => {
  const viaRemote = { viaRemote: true };
  it('a remote 404 not_shared says "No longer shared" (Review Focus 1)', () => {
    expect(mountFailureText({ error: 'not_shared' }, 404, viaRemote, 'floppy.example')).toBe('No longer shared');
  });
  it('remote codes are worded, with the host', () => {
    expect(mountFailureText({ error: 'unreachable', host: 'h.example' }, 502, viaRemote, 'floppy.example')).toBe("Can't reach h.example");
    expect(mountFailureText({ error: 'ended' }, 410, viaRemote)).toBe('Access ended');
    // final review 6: the detail reaches the words, and a garbled answer is not "needs an update".
    expect(mountFailureText({ error: 'protocol', detail: 'local_older', host: 'h.example' }, 409, viaRemote)).toBe('Your WebFloppy needs an update');
    expect(mountFailureText({ error: 'protocol', detail: 'remote_older', host: 'h.example' }, 409, viaRemote)).toBe('h.example needs a WebFloppy update');
    expect(mountFailureText({ error: 'bad_response', host: 'h.example' }, 502, viaRemote)).toBe("h.example didn't answer like a WebFloppy");
  });
  it('a reason sentence wins; a local code is never worded as remote', () => {
    expect(mountFailureText({ reason: 'DF1 is off.' }, 409, viaRemote)).toBe('DF1 is off.');
    expect(mountFailureText({ error: 'not_shared' }, 404, { viaRemote: false })).toBe('The server answered 404.');
    expect(mountFailureText(null, 500, viaRemote)).toBe('The server answered 500.');
  });
});
