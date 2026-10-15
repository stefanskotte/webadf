import { describe, it, expect, vi } from 'vitest';
import { settle } from './settle';

describe('settle', () => {
  it('passes a value through', async () => {
    expect(await settle(Promise.resolve(3))).toEqual({ ok: true, value: 3 });
  });
  it('turns a rejection into ok:false and logs it', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await settle(Promise.reject(new Error('db down')))).toEqual({ ok: false });
    expect(err).toHaveBeenCalled();
    err.mockRestore();
  });
});
