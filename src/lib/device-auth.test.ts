import { describe, it, expect } from 'vitest';
import { DeviceAuthError, deviceAuthResponse } from './device-auth';

describe('deviceAuthResponse', () => {
  it('converts a DeviceAuthError into a 401', async () => {
    const res = deviceAuthResponse(new DeviceAuthError());
    expect(res).not.toBeNull();
    expect(res!.status).toBe(401);
    await expect(res!.json()).resolves.toEqual({ error: 'unauthorized' });
  });

  it('returns null for any other error, so a real bug is never masked as a 401', () => {
    expect(deviceAuthResponse(new TypeError('cannot read x of undefined'))).toBeNull();
    expect(deviceAuthResponse(new Error('boom'))).toBeNull();
    expect(deviceAuthResponse('a string')).toBeNull();
    expect(deviceAuthResponse(undefined)).toBeNull();
  });

  it('does not leak the reason for the failure', async () => {
    const body = await deviceAuthResponse(new DeviceAuthError())!.json();
    expect(JSON.stringify(body)).not.toMatch(/token|hash|bearer|device/i);
  });
});
