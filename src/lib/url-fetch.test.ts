import { describe, it, expect, vi } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  isPublicAddress, vetUrl, fetchUrlSafely, nodeTransport,
  type Resolver, type Transport, type TransportRequest, type UrlFetchLimits, URL_FETCH_LIMITS,
} from './url-fetch';

describe('isPublicAddress: IPv4', () => {
  it.each([
    ['0.0.0.0'], ['0.1.2.3'], ['10.0.0.1'], ['10.255.255.255'], ['100.64.0.1'], ['100.127.255.254'],
    ['127.0.0.1'], ['127.1.2.3'], ['169.254.169.254'], ['169.254.0.1'], ['172.16.0.1'], ['172.31.255.255'],
    ['192.0.0.1'], ['192.0.2.1'], ['192.88.99.1'], ['192.168.1.1'], ['198.18.0.1'], ['198.19.255.255'],
    ['198.51.100.7'], ['203.0.113.9'], ['224.0.0.1'], ['239.255.255.250'], ['240.0.0.1'], ['255.255.255.255'],
  ])('refuses %s', (ip) => {
    expect(isPublicAddress(ip)).toBe(false);
  });

  it.each([
    ['1.1.1.1'], ['8.8.8.8'], ['93.184.215.14'], ['100.63.255.255'], ['100.128.0.0'], ['172.15.255.255'],
    ['172.32.0.0'], ['169.253.255.255'], ['192.169.0.1'], ['198.20.0.1'], ['223.255.255.255'], ['11.0.0.1'],
  ])('allows %s', (ip) => {
    expect(isPublicAddress(ip)).toBe(true);
  });
});

describe('isPublicAddress: IPv6', () => {
  it.each([
    ['::'], ['::1'], ['[::1]'], ['::ffff:127.0.0.1'], ['::ffff:7f00:1'], ['::ffff:10.0.0.1'], ['::ffff:169.254.169.254'],
    ['::ffff:a9fe:a9fe'], ['::127.0.0.1'], ['::1.2.3.4'], ['64:ff9b::7f00:1'], ['64:ff9b::10.1.2.3'], ['64:ff9b:1::1'],
    ['fc00::1'], ['fd12:3456::1'], ['fe80::1'], ['fe80::1%eth0'], ['fec0::1'], ['ff02::1'], ['ff05::2'], ['100::1'],
    ['2001::1'], ['2001:0:4136:e378::1'], ['2001:db8::1'], ['2002:c0a8:101::1'], ['3fff::1'],
    ['not-an-ip'], [''], ['1.2.3'], ['example.com'],
  ])('refuses %s', (ip) => {
    expect(isPublicAddress(ip)).toBe(false);
  });

  it.each([
    ['2606:4700:4700::1111'], ['2a00:1450:4001:80b::200e'], ['::ffff:8.8.8.8'], ['::ffff:808:808'], ['64:ff9b::8.8.8.8'],
    ['2001:4860:4860::8888'], ['2400:cb00::1'],
  ])('allows %s', (ip) => {
    expect(isPublicAddress(ip)).toBe(true);
  });
});

describe('vetUrl', () => {
  it.each([
    ['ftp://example.com/a.adf', 'unsupported_scheme'],
    ['file:///etc/passwd', 'unsupported_scheme'],
    ['gopher://example.com/', 'unsupported_scheme'],
    ['data:application/octet-stream;base64,AAAA', 'unsupported_scheme'],
    ['javascript:alert(1)', 'unsupported_scheme'],
    ['https://user:pw@example.com/a.adf', 'credentials_not_allowed'],
    ['https://user@example.com/a.adf', 'credentials_not_allowed'],
    ['http://example.com:8080/a.adf', 'port_not_allowed'],
    ['http://example.com:22/a.adf', 'port_not_allowed'],
    ['https://example.com:6379/', 'port_not_allowed'],
    ['not a url', 'invalid_url'],
    ['', 'invalid_url'],
    [`https://example.com/${'a'.repeat(3000)}`, 'invalid_url'],
  ])('%s -> %s', (raw, code) => {
    expect(vetUrl(raw)).toEqual({ ok: false, code });
  });

  it('accepts http/https on default and 80/443 ports, and drops the fragment', () => {
    for (const raw of ['http://example.com/a.adf', 'https://example.com/a.adf', 'http://example.com:80/x', 'https://example.com:443/x', 'https://example.com:80/x']) {
      expect(vetUrl(raw).ok).toBe(true);
    }
    const v = vetUrl('https://example.com/a.adf#frag');
    expect(v.ok && v.url.toString()).toBe('https://example.com/a.adf');
  });
});

// ------------------------------------------------------------------ fetch

const PUBLIC = '93.184.215.14';
const publicResolver: Resolver = async () => [{ address: PUBLIC, family: 4 }];

type Reply = { status: number; headers?: Record<string, string>; chunks?: Uint8Array[]; body?: AsyncIterable<Uint8Array> };

function fakeTransport(replies: Record<string, Reply | ((r: TransportRequest) => Promise<Reply>)>) {
  const seen: TransportRequest[] = [];
  let destroyed = 0;
  const transport: Transport = async (req) => {
    seen.push(req);
    const entry = replies[req.url.toString()];
    if (!entry) throw new Error(`ECONNREFUSED ${req.url}`);
    const r = typeof entry === 'function' ? await entry(req) : entry;
    const chunks = r.chunks ?? [];
    return {
      status: r.status,
      headers: r.headers ?? {},
      body: r.body ?? (async function* () { for (const c of chunks) yield c; })(),
      destroy: () => { destroyed++; },
    };
  };
  return { transport, seen, destroyed: () => destroyed };
}

const limits = (over: Partial<UrlFetchLimits> = {}): UrlFetchLimits => ({ ...URL_FETCH_LIMITS, ...over });

describe('fetchUrlSafely', () => {
  it('fetches a public URL, connecting to the address it vetted', async () => {
    const t = fakeTransport({ 'https://files.example/a.adf': { status: 200, chunks: [new Uint8Array([1, 2]), new Uint8Array([3])] } });
    const r = await fetchUrlSafely('https://files.example/a.adf', { resolve: publicResolver, transport: t.transport });
    expect(r.ok).toBe(true);
    if (r.ok) expect([...r.bytes]).toEqual([1, 2, 3]);
    expect(t.seen).toHaveLength(1);
    expect(t.seen[0].address).toBe(PUBLIC);
    expect(t.seen[0].headers['accept-encoding']).toBe('identity');
  });

  it('refuses scheme and credentials without resolving or connecting', async () => {
    const resolve = vi.fn(publicResolver);
    const t = fakeTransport({});
    expect(await fetchUrlSafely('file:///etc/passwd', { resolve, transport: t.transport })).toEqual({ ok: false, code: 'unsupported_scheme' });
    expect(await fetchUrlSafely('https://a:b@files.example/', { resolve, transport: t.transport })).toEqual({ ok: false, code: 'credentials_not_allowed' });
    expect(resolve).not.toHaveBeenCalled();
    expect(t.seen).toHaveLength(0);
  });

  it.each([
    'http://127.0.0.1/a.adf', 'http://[::1]/a.adf', 'http://169.254.169.254/latest/meta-data/', 'http://10.0.0.5/',
    'http://[::ffff:127.0.0.1]/', 'http://2130706433/', 'http://0x7f.1/', 'http://0177.0.0.1/', 'http://localhost/',
    'http://foo.localhost/', 'http://0/',
  ])('refuses the private literal %s without connecting', async (raw) => {
    const resolve = vi.fn(publicResolver);
    const t = fakeTransport({});
    expect(await fetchUrlSafely(raw, { resolve, transport: t.transport })).toEqual({ ok: false, code: 'address_not_allowed' });
    expect(resolve).not.toHaveBeenCalled();
    expect(t.seen).toHaveLength(0);
  });

  it('refuses a hostname that resolves to a private address', async () => {
    const t = fakeTransport({});
    const r = await fetchUrlSafely('https://evil.example/', {
      resolve: async () => [{ address: '10.1.2.3', family: 4 }], transport: t.transport,
    });
    expect(r).toEqual({ ok: false, code: 'address_not_allowed' });
    expect(t.seen).toHaveLength(0);
  });

  it('refuses a hostname with ANY private record among public ones', async () => {
    const t = fakeTransport({});
    const r = await fetchUrlSafely('https://mixed.example/', {
      resolve: async () => [{ address: PUBLIC, family: 4 }, { address: 'fd00::1', family: 6 }], transport: t.transport,
    });
    expect(r).toEqual({ ok: false, code: 'address_not_allowed' });
    expect(t.seen).toHaveLength(0);
  });

  it('resolves once per hop and pins the connection: a rebinding second answer is never used', async () => {
    let calls = 0;
    const rebinding: Resolver = async () => (++calls === 1 ? [{ address: PUBLIC, family: 4 }] : [{ address: '127.0.0.1', family: 4 }]);
    const t = fakeTransport({ 'https://rebind.example/a.adf': { status: 200, chunks: [new Uint8Array([9])] } });
    const r = await fetchUrlSafely('https://rebind.example/a.adf', { resolve: rebinding, transport: t.transport });
    expect(r.ok).toBe(true);
    expect(calls).toBe(1);
    expect(t.seen[0].address).toBe(PUBLIC);
  });

  it('hands the transport every vetted address, in resolver order', async () => {
    const t = fakeTransport({ 'https://dual.example/a.adf': { status: 200, chunks: [new Uint8Array([9])] } });
    const r = await fetchUrlSafely('https://dual.example/a.adf', {
      resolve: async () => [{ address: '2606:4700::1111', family: 6 }, { address: PUBLIC, family: 4 }], transport: t.transport,
    });
    expect(r.ok).toBe(true);
    expect(t.seen[0].addresses).toEqual([{ address: '2606:4700::1111', family: 6 }, { address: PUBLIC, family: 4 }]);
    expect(t.seen[0].address).toBe('2606:4700::1111');
  });

  it('follows a redirect to another public host, re-vetting it', async () => {
    const resolve = vi.fn(publicResolver);
    const t = fakeTransport({
      'https://a.example/x': { status: 302, headers: { location: 'https://b.example/y.adf' } },
      'https://b.example/y.adf': { status: 200, chunks: [new Uint8Array([7])] },
    });
    const r = await fetchUrlSafely('https://a.example/x', { resolve, transport: t.transport });
    expect(r.ok && r.finalUrl.toString()).toBe('https://b.example/y.adf');
    expect(resolve.mock.calls.map((c) => c[0])).toEqual(['a.example', 'b.example']);
  });

  it('refuses a redirect to a private literal', async () => {
    const t = fakeTransport({ 'https://a.example/x': { status: 301, headers: { location: 'http://169.254.169.254/latest/' } } });
    const r = await fetchUrlSafely('https://a.example/x', { resolve: publicResolver, transport: t.transport });
    expect(r).toEqual({ ok: false, code: 'address_not_allowed' });
    expect(t.seen).toHaveLength(1);
  });

  it('refuses a redirect to a name that resolves privately', async () => {
    const resolve: Resolver = async (h) => (h === 'inside.example' ? [{ address: '192.168.0.10', family: 4 }] : [{ address: PUBLIC, family: 4 }]);
    const t = fakeTransport({ 'https://a.example/x': { status: 307, headers: { location: 'https://inside.example/admin' } } });
    expect(await fetchUrlSafely('https://a.example/x', { resolve, transport: t.transport })).toEqual({ ok: false, code: 'address_not_allowed' });
    expect(t.seen).toHaveLength(1);
  });

  it('refuses a redirect to another scheme, credentials or port', async () => {
    for (const [location, code] of [
      ['file:///etc/passwd', 'unsupported_scheme'],
      ['https://u:p@b.example/', 'credentials_not_allowed'],
      ['http://b.example:8080/', 'port_not_allowed'],
    ] as const) {
      const t = fakeTransport({ 'https://a.example/x': { status: 302, headers: { location } } });
      expect(await fetchUrlSafely('https://a.example/x', { resolve: publicResolver, transport: t.transport })).toEqual({ ok: false, code });
    }
  });

  it('caps redirects', async () => {
    const replies: Record<string, Reply> = {};
    for (let i = 0; i < 6; i++) replies[`https://a.example/${i}`] = { status: 302, headers: { location: `/${i + 1}` } };
    const t = fakeTransport(replies);
    const r = await fetchUrlSafely('https://a.example/0', { resolve: publicResolver, transport: t.transport }, limits({ maxRedirects: 3 }));
    expect(r).toEqual({ ok: false, code: 'too_many_redirects' });
    expect(t.seen).toHaveLength(4);
  });

  it('refuses a non-200 with its status only', async () => {
    const t = fakeTransport({ 'https://a.example/x': { status: 404, chunks: [new TextEncoder().encode('secret internal page')] } });
    const r = await fetchUrlSafely('https://a.example/x', { resolve: publicResolver, transport: t.transport });
    expect(r).toEqual({ ok: false, code: 'upstream_status', status: 404 });
  });

  it('refuses early on an honest oversize Content-Length', async () => {
    const t = fakeTransport({ 'https://a.example/x': { status: 200, headers: { 'content-length': '999999999' }, chunks: [] } });
    const r = await fetchUrlSafely('https://a.example/x', { resolve: publicResolver, transport: t.transport });
    expect(r).toEqual({ ok: false, code: 'too_large' });
    expect(t.destroyed()).toBeGreaterThan(0);
  });

  it('aborts an oversize stream that lied about (or omitted) its length', async () => {
    let produced = 0;
    const endless = (async function* () {
      for (;;) { produced += 1024; yield new Uint8Array(1024); }
    })();
    const t = fakeTransport({ 'https://a.example/x': { status: 200, headers: { 'content-length': '10' }, body: endless } });
    const r = await fetchUrlSafely('https://a.example/x', { resolve: publicResolver, transport: t.transport }, limits({ maxBytes: 64 * 1024 }));
    expect(r).toEqual({ ok: false, code: 'too_large' });
    expect(produced).toBeLessThanOrEqual(66 * 1024);
    expect(t.destroyed()).toBeGreaterThan(0);
  });

  it('times out a stalled body', async () => {
    const stalled = { [Symbol.asyncIterator]: () => ({ next: () => new Promise<IteratorResult<Uint8Array>>(() => {}) }) };
    const t = fakeTransport({ 'https://a.example/x': { status: 200, body: stalled } });
    const r = await fetchUrlSafely('https://a.example/x', { resolve: publicResolver, transport: t.transport }, limits({ timeoutMs: 50 }));
    expect(r).toEqual({ ok: false, code: 'timeout' });
  });

  it('times out a resolver that never answers', async () => {
    const t = fakeTransport({});
    const r = await fetchUrlSafely('https://a.example/x', { resolve: () => new Promise(() => {}), transport: t.transport }, limits({ timeoutMs: 50 }));
    expect(r).toEqual({ ok: false, code: 'timeout' });
  });

  it('reports a failed connection or DNS lookup as unreachable, with no detail', async () => {
    const t = fakeTransport({});
    expect(await fetchUrlSafely('https://a.example/x', { resolve: publicResolver, transport: t.transport })).toEqual({ ok: false, code: 'unreachable' });
    expect(await fetchUrlSafely('https://a.example/x', { resolve: async () => { throw new Error('ENOTFOUND'); }, transport: t.transport }))
      .toEqual({ ok: false, code: 'unreachable' });
    expect(await fetchUrlSafely('https://a.example/x', { resolve: async () => [], transport: t.transport }))
      .toEqual({ ok: false, code: 'unreachable' });
  });
});

describe('nodeTransport', () => {
  it('falls back to the next vetted address when the first is unreachable, and never leaves the list', async () => {
    const server = http.createServer((_req, res) => { res.writeHead(200); res.end(Buffer.from([5, 6])); });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const { port } = server.address() as AddressInfo;
    try {
      const url = new URL(`http://no-such-host.invalid:${port}/disk.adf`);
      const res = await nodeTransport({
        url, address: '::1', family: 6,
        addresses: [{ address: '::1', family: 6 }, { address: '127.0.0.1', family: 4 }],
        headers: {}, signal: new AbortController().signal,
      });
      const chunks: Uint8Array[] = [];
      for await (const c of res.body) chunks.push(c);
      expect(res.status).toBe(200);
      expect(Buffer.concat(chunks)).toEqual(Buffer.from([5, 6]));
    } finally {
      server.close();
    }
  });

  it('with no address list, still connects only to the single pinned address', async () => {
    const server = http.createServer((_req, res) => { res.writeHead(200); res.end(); });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const { port } = server.address() as AddressInfo;
    try {
      const url = new URL(`http://no-such-host.invalid:${port}/`);
      const res = await nodeTransport({ url, address: '127.0.0.1', family: 4, headers: {}, signal: new AbortController().signal });
      expect(res.status).toBe(200);
    } finally {
      server.close();
    }
  });

  it('connects to the pinned address, never resolving the hostname itself', async () => {
    // A name that does not exist anywhere. If the transport consulted DNS it
    // would fail; pinned to the local test server, it reaches it -- and the
    // Host header still names the original host.
    let hostHeader: string | undefined;
    const server = http.createServer((req, res) => {
      hostHeader = req.headers.host;
      res.writeHead(200, { 'content-type': 'application/octet-stream' });
      res.end(Buffer.from([1, 2, 3, 4]));
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const { port } = server.address() as AddressInfo;
    try {
      const url = new URL(`http://no-such-host.invalid:${port}/disk.adf`);
      const controller = new AbortController();
      const res = await nodeTransport({ url, address: '127.0.0.1', family: 4, headers: {}, signal: controller.signal });
      const chunks: Uint8Array[] = [];
      for await (const c of res.body) chunks.push(c);
      expect(res.status).toBe(200);
      expect(Buffer.concat(chunks)).toEqual(Buffer.from([1, 2, 3, 4]));
      expect(hostHeader).toBe(`no-such-host.invalid:${port}`);
    } finally {
      server.close();
    }
  });
});
