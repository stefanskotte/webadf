import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

const toastError = vi.fn();
vi.mock('sonner', () => ({ toast: { error: (...a: unknown[]) => toastError(...a) } }));

import { NativeDropProvider, useNativeDrop } from './native-drop';

function grab() {
  let value: ReturnType<typeof useNativeDrop> = null;
  function Probe() { value = useNativeDrop(); return null; }
  renderToStaticMarkup(createElement(NativeDropProvider, null, createElement(Probe)));
  return value!;
}

describe('NativeDropProvider.receive', () => {
  beforeEach(() => toastError.mockClear());
  const items = {} as DataTransferItemList;

  it('says so when a drop arrives before the staging receiver has registered', () => {
    const nd = grab();
    expect(nd.available()).toBe(false);
    nd.receive(items, 7);
    expect(toastError).toHaveBeenCalledTimes(1);
    expect(toastError.mock.calls[0][0]).toBe('Not ready yet');
  });

  it('hands the drop to a registered receiver and stays quiet', () => {
    const nd = grab();
    const got = vi.fn();
    nd.register(got);
    nd.receive(items, 7);
    expect(got).toHaveBeenCalledWith(items, 7);
    expect(toastError).not.toHaveBeenCalled();
  });
});
