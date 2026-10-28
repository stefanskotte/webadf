import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import http from 'node:http';
import https from 'node:https';
import { createHash, X509Certificate } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import {
  shareClient, rootPinMatches, nodeShareTransport, ShareTransportError, SHARE_LIMITS,
  type ShareTransport,
} from './client';
import type { ResolvedAddress } from '@/lib/url-fetch';
import type { ShareEnv } from './link';
import { MAX_DISK_BYTES } from '@/lib/blob-upload';

type Req = Parameters<ShareTransport>[0];
type Res = Awaited<ReturnType<ShareTransport>>;

const enc = new TextEncoder();
const PROTO = { 'x-webfloppy-share-protocol': '1' };
const json = (status: number, body: unknown, headers: Record<string, string> = PROTO): Res =>
  ({ status, headers: { 'content-type': 'application/json', ...headers }, body: enc.encode(JSON.stringify(body)) });

const CODE = 'wfsc_' + 'B'.repeat(43);
const TOKEN = 'wfst_' + 'C'.repeat(43);
const OWNER = { origin: 'https://owner.example.com', pin: null, token: TOKEN };
const PUBLIC_IP = '93.184.215.14';

function harness(opts: {
  addrs?: ResolvedAddress[] | ((host: string) => ResolvedAddress[]);
  reply?: Res | ((req: Req) => Res | Promise<Res>);
  env?: ShareEnv;
} = {}) {
  const calls: Req[] = [];
  const resolved: string[] = [];
  const client = shareClient({
    env: opts.env ?? {},
    resolve: async (host) => {
      resolved.push(host);
      const a = opts.addrs ?? [{ address: PUBLIC_IP, family: 4 }];
      return typeof a === 'function' ? a(host) : a;
    },
    transport: async (req) => {
      calls.push(req);
      const r = opts.reply ?? json(200, { ok: true, protocol: 1 });
      return typeof r === 'function' ? r(req) : r;
    },
  });
  return { client, calls, resolved };
}

const v4 = (address: string): ResolvedAddress => ({ address, family: 4 });
const v6 = (address: string): ResolvedAddress => ({ address, family: 6 });

describe('address guard', () => {
  it('connects to the vetted public address, never re-resolving', async () => {
    const h = harness();
    const r = await h.client.ping(OWNER);
    expect(r).toEqual({ ok: true, value: { protocol: 1 } });
    expect(h.resolved).toEqual(['owner.example.com']);
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0].address).toBe(PUBLIC_IP);
    expect(h.calls[0].url.toString()).toBe('https://owner.example.com/api/share/v1/ping');
    expect(h.calls[0].method).toBe('GET');
  });

  it.each([['10.0.0.5'], ['192.168.1.20'], ['172.20.0.3'], ['100.64.1.1']])('refuses private %s by default', async (ip) => {
    const h = harness({ addrs: [v4(ip)] });
    const r = await h.client.ping(OWNER);
    expect(r).toMatchObject({ ok: false, failure: 'unreachable', detail: 'address_not_allowed' });
    expect(h.calls).toHaveLength(0);
  });

  it('refuses private with WEBADF_SHARE_PRIVATE_ADDRESSES=0 and any value but 1', async () => {
    for (const v of ['0', 'true', 'yes', '']) {
      const h = harness({ addrs: [v4('10.0.0.5')], env: { WEBADF_SHARE_PRIVATE_ADDRESSES: v } });
      expect(await h.client.ping(OWNER)).toMatchObject({ ok: false, failure: 'unreachable' });
      expect(h.calls).toHaveLength(0);
    }
  });

  it.each([['10.0.0.5'], ['192.168.1.20'], ['172.20.0.3'], ['100.64.1.1'], ['fd12:3456::1'], ['::ffff:192.168.1.2']])(
    'allows private %s with WEBADF_SHARE_PRIVATE_ADDRESSES=1', async (ip) => {
      const h = harness({ addrs: [ip.includes(':') ? v6(ip) : v4(ip)], env: { WEBADF_SHARE_PRIVATE_ADDRESSES: '1' } });
      expect(await h.client.ping(OWNER)).toMatchObject({ ok: true });
      expect(h.calls[0].address).toBe(ip);
    });

  it('refuses a name with one public and one private address unless private is allowed', async () => {
    const both = [v4(PUBLIC_IP), v4('10.0.0.5')];
    expect(await harness({ addrs: both }).client.ping(OWNER)).toMatchObject({ ok: false, detail: 'address_not_allowed' });
    expect(await harness({ addrs: both, env: { WEBADF_SHARE_PRIVATE_ADDRESSES: '1' } }).client.ping(OWNER)).toMatchObject({ ok: true });
  });

  it.each([['127.0.0.1'], ['127.8.9.1'], ['::1'], ['::ffff:127.0.0.1']])(
    'refuses loopback %s even with private allowed', async (ip) => {
      const h = harness({ addrs: [ip.includes(':') ? v6(ip) : v4(ip)], env: { WEBADF_SHARE_PRIVATE_ADDRESSES: '1' } });
      expect(await h.client.ping(OWNER)).toMatchObject({ ok: false, failure: 'unreachable', detail: 'address_not_allowed' });
      expect(h.calls).toHaveLength(0);
    });

  it('allows loopback only with WEBADF_SHARE_TEST_INSECURE=1', async () => {
    const h = harness({ addrs: [v4('127.0.0.1')], env: { WEBADF_SHARE_TEST_INSECURE: '1' } });
    expect(await h.client.ping(OWNER)).toMatchObject({ ok: true });
    expect(h.calls[0].address).toBe('127.0.0.1');
  });

  it.each([['169.254.169.254'], ['0.0.0.0'], ['224.0.0.1'], ['fe80::1'], ['ff02::1'], ['198.51.100.7']])(
    'refuses %s under every switch', async (ip) => {
      const env = { WEBADF_SHARE_PRIVATE_ADDRESSES: '1', WEBADF_SHARE_TEST_INSECURE: '1' };
      const h = harness({ addrs: [ip.includes(':') ? v6(ip) : v4(ip)], env });
      expect(await h.client.ping(OWNER)).toMatchObject({ ok: false, failure: 'unreachable', detail: 'address_not_allowed' });
      expect(h.calls).toHaveLength(0);
    });

  it('vets an IP-literal origin without asking DNS', async () => {
    const t = { origin: 'https://10.0.0.5:8443', pin: null };
    const refused = harness();
    expect(await refused.client.ping(t)).toMatchObject({ ok: false, detail: 'address_not_allowed' });
    expect(refused.resolved).toEqual([]);
    const allowed = harness({ env: { WEBADF_SHARE_PRIVATE_ADDRESSES: '1' } });
    expect(await allowed.client.ping(t)).toMatchObject({ ok: true });
    expect(allowed.calls[0].address).toBe('10.0.0.5');
    expect(allowed.calls[0].url.toString()).toBe('https://10.0.0.5:8443/api/share/v1/ping');
    expect(allowed.resolved).toEqual([]);
  });

  it('refuses localhost names without TEST_INSECURE, whatever DNS says', async () => {
    const h = harness({ addrs: [v4(PUBLIC_IP)], env: { WEBADF_SHARE_PRIVATE_ADDRESSES: '1' } });
    expect(await h.client.ping({ origin: 'https://localhost', pin: null })).toMatchObject({ ok: false, detail: 'address_not_allowed' });
    expect(await h.client.ping({ origin: 'https://a.localhost', pin: null })).toMatchObject({ ok: false, detail: 'address_not_allowed' });
    expect(h.calls).toHaveLength(0);
  });

  it('a resolver failure or empty answer is unreachable', async () => {
    const empty = harness({ addrs: [] });
    expect(await empty.client.ping(OWNER)).toMatchObject({ ok: false, failure: 'unreachable' });
    const throwing = shareClient({ env: {}, resolve: async () => { throw new Error('ENOTFOUND'); }, transport: async () => json(200, {}) });
    expect(await throwing.ping(OWNER)).toMatchObject({ ok: false, failure: 'unreachable', detail: 'dns' });
  });
});

describe('origin rules', () => {
  it('refuses http unless TEST_INSECURE, without resolving', async () => {
    const t = { origin: 'http://owner.example.com', pin: null };
    const h = harness();
    expect(await h.client.ping(t)).toMatchObject({ ok: false, failure: 'unreachable', detail: 'scheme' });
    expect(h.resolved).toEqual([]);
    const ok = harness({ env: { WEBADF_SHARE_TEST_INSECURE: '1' } });
    expect(await ok.client.ping(t)).toMatchObject({ ok: true });
    expect(ok.calls[0].url.protocol).toBe('http:');
  });

  it.each([['ftp://owner.example.com'], ['not a url'], ['https://u:p@owner.example.com'], ['https://owner.example.com/sub']])(
    'refuses origin %j', async (origin) => {
      const h = harness();
      expect(await h.client.ping({ origin, pin: null })).toMatchObject({ ok: false, failure: 'unreachable' });
      expect(h.calls).toHaveLength(0);
    });

  it('keeps every request under /api/share/v1/', async () => {
    const h = harness({ reply: json(200, {}) });
    for (const p of ['', '?q=x', '../../api/devices', 'titles/..', 'disks/%2E%2E/x', '..%2f..%2fapi', '%2e%2e/x', '/abs', '//evil.example/x', 'a\\b', 'x#frag', 'https://evil.example/']) {
      expect(await h.client.getJson(OWNER, p)).toMatchObject({ ok: false, failure: 'bad_response', detail: 'path' });
    }
    expect(h.calls).toHaveLength(0);
    await h.client.getJson(OWNER, 'titles?collection=abc&q=lotus%20turbo&cursor=x');
    expect(h.calls[0].url.toString()).toBe('https://owner.example.com/api/share/v1/titles?collection=abc&q=lotus%20turbo&cursor=x');
    await h.client.getJson(OWNER, `titles?q=${encodeURIComponent('AC/DC ../..')}`);
    expect(h.calls[1].url.pathname).toBe('/api/share/v1/titles');
    expect(h.calls[1].url.searchParams.get('q')).toBe('AC/DC ../..');
  });
});

describe('requests', () => {
  it('sends the token, the protocol header and no credentials anywhere else', async () => {
    const h = harness({ reply: json(200, { name: 'Rob' }) });
    const r = await h.client.getJson<{ name: string }>(OWNER, 'library');
    expect(r).toEqual({ ok: true, value: { name: 'Rob' } });
    const req = h.calls[0];
    expect(req.headers.authorization).toBe(`Bearer ${TOKEN}`);
    expect(req.headers['x-webfloppy-share-protocol']).toBe('1');
    expect(req.headers['accept-encoding']).toBe('identity');
    expect(req.headers['user-agent']).toMatch(/^webadf\//);
    expect(req.url.toString()).toBe('https://owner.example.com/api/share/v1/library');
    expect(req.maxBytes).toBe(SHARE_LIMITS.listing.maxBytes);
    expect(req.timeoutMs).toBe(SHARE_LIMITS.listing.timeoutMs);
  });

  it('listing limits are 2 MB / 10 s, bytes MAX_DISK_BYTES / 60 s', () => {
    expect(SHARE_LIMITS.listing).toEqual({ maxBytes: 2 * 1024 * 1024, timeoutMs: 10_000 });
    expect(SHARE_LIMITS.bytes).toEqual({ maxBytes: MAX_DISK_BYTES, timeoutMs: 60_000 });
  });

  it('passes the pin to the transport', async () => {
    const h = harness();
    await h.client.ping({ origin: 'https://owner.example.com', pin: 'P'.repeat(43) });
    expect(h.calls[0].pin).toBe('P'.repeat(43));
  });

  it('claim POSTs JSON with protocol 1 and no Authorization', async () => {
    const h = harness({ reply: json(200, { token: TOKEN, protocol: 1, library: { name: "Rob's library" } }) });
    const r = await h.client.claim({ origin: 'https://owner.example.com', pin: null }, CODE,
      { instanceUrl: 'https://mine.example.org', instanceName: 'Mine' });
    expect(r).toEqual({ ok: true, value: { token: TOKEN, library: { name: "Rob's library" } } });
    const req = h.calls[0];
    expect(req.method).toBe('POST');
    expect(req.url.toString()).toBe('https://owner.example.com/api/share/v1/claim');
    expect(req.headers['content-type']).toBe('application/json');
    expect(req.headers.authorization).toBeUndefined();
    expect(JSON.parse(req.body!)).toEqual({ code: CODE, protocol: 1, instanceUrl: 'https://mine.example.org', instanceName: 'Mine' });
  });

  it('claim never sends a token it was handed', async () => {
    const h = harness({ reply: json(200, { token: TOKEN, protocol: 1, library: { name: 'x' } }) });
    await h.client.claim(OWNER, CODE, { instanceUrl: 'https://m', instanceName: 'm' });
    expect(h.calls[0].headers.authorization).toBeUndefined();
  });

  it('claim refuses a malformed code without contacting anyone', async () => {
    const h = harness();
    expect(await h.client.claim(OWNER, 'wfsc_short', { instanceUrl: 'https://m', instanceName: 'm' }))
      .toMatchObject({ ok: false, failure: 'invalid_or_used' });
    expect(h.calls).toHaveLength(0);
  });

  it.each([
    [{ protocol: 1, library: { name: 'x' } }],
    [{ token: 'nope', protocol: 1, library: { name: 'x' } }],
    [{ token: TOKEN, protocol: 1, library: {} }],
    [{ token: TOKEN, protocol: 2, library: { name: 'x' } }],
    ['a string'],
  ])('claim: a malformed success body %j is bad_response', async (body) => {
    const h = harness({ reply: json(200, body) });
    expect(await h.client.claim(OWNER, CODE, { instanceUrl: 'https://m', instanceName: 'm' }))
      .toMatchObject({ ok: false, failure: 'bad_response' });
  });

  it('ping: a body without a numeric protocol is bad_response', async () => {
    expect(await harness({ reply: json(200, { ok: true }) }).client.ping(OWNER)).toMatchObject({ ok: false, failure: 'bad_response' });
  });

  it('getJson: an unparsable body is bad_response', async () => {
    const h = harness({ reply: { status: 200, headers: PROTO, body: enc.encode('<html>') } });
    expect(await h.client.getJson(OWNER, 'library')).toMatchObject({ ok: false, failure: 'bad_response' });
  });

  it('getBytes returns the bytes and the unquoted ETag, under the bytes limits', async () => {
    const sha = 'a'.repeat(64);
    const bytes = new Uint8Array([1, 2, 3, 4]);
    const h = harness({ reply: { status: 200, headers: { ...PROTO, etag: `"${sha}"` }, body: bytes } });
    const r = await h.client.getBytes(OWNER, 'disks/d1/bytes');
    expect(r).toEqual({ ok: true, value: bytes, etag: sha });
    expect(h.calls[0].maxBytes).toBe(MAX_DISK_BYTES);
    expect(h.calls[0].timeoutMs).toBe(60_000);
    expect(h.calls[0].headers.authorization).toBe(`Bearer ${TOKEN}`);
  });

  it('getBytes: a weak or bare ETag is unquoted too; none leaves etag out', async () => {
    const mk = (etag?: string) => harness({ reply: { status: 200, headers: { ...PROTO, ...(etag ? { etag } : {}) }, body: new Uint8Array([9]) } });
    expect(await mk('W/"abc"').client.getBytes(OWNER, 'covers/x')).toMatchObject({ etag: 'abc' });
    expect(await mk('abc').client.getBytes(OWNER, 'covers/x')).toMatchObject({ etag: 'abc' });
    const none = await mk().client.getBytes(OWNER, 'covers/x');
    expect(none).toEqual({ ok: true, value: new Uint8Array([9]) });
  });
});

describe('status mapping', () => {
  it.each([
    [401, { error: 'unauthorized' }, 'ended'],
    [404, { error: 'invalid_or_used' }, 'invalid_or_used'],
    [404, { error: 'not_found' }, 'not_found'],
    [404, 'not json', 'not_found'],
    [409, { error: 'protocol', supported: [1] }, 'protocol'],
    [429, { error: 'rate_limited' }, 'rate_limited'],
    [400, { error: 'bad_request' }, 'bad_response'],
    [403, {}, 'bad_response'],
    [418, {}, 'bad_response'],
    [500, {}, 'unreachable'],
    [503, { error: 'unavailable' }, 'unreachable'],
  ])('%i %j -> %s', async (status, body, failure) => {
    const reply: Res = typeof body === 'string'
      ? { status, headers: PROTO, body: enc.encode(body) }
      : json(status, body);
    const r = await harness({ reply }).client.getJson(OWNER, 'library');
    expect(r).toMatchObject({ ok: false, failure });
  });

  it.each([[301], [302], [303], [307], [308]])('%i redirect is bad_response, never followed', async (status) => {
    const h = harness({ reply: { status, headers: { ...PROTO, location: 'https://10.0.0.1/' }, body: new Uint8Array() } });
    expect(await h.client.getJson(OWNER, 'library')).toMatchObject({ ok: false, failure: 'bad_response', detail: 'redirect' });
    expect(h.calls).toHaveLength(1);
  });

  it('a 5xx from a proxy without the protocol header is still unreachable', async () => {
    const r = await harness({ reply: { status: 502, headers: {}, body: enc.encode('Bad Gateway') } }).client.ping(OWNER);
    expect(r).toMatchObject({ ok: false, failure: 'unreachable' });
  });

  it('a missing protocol header is bad_response, on success and on errors', async () => {
    for (const status of [200, 401, 404, 409, 429]) {
      const r = await harness({ reply: json(status, { ok: true, protocol: 1, error: 'x' }, {}) }).client.ping(OWNER);
      expect(r).toMatchObject({ ok: false, failure: 'bad_response', detail: 'protocol_header' });
    }
  });

  it('429 keeps Retry-After as the detail', async () => {
    const r = await harness({ reply: json(429, { error: 'rate_limited' }, { ...PROTO, 'retry-after': '17' }) }).client.ping(OWNER);
    expect(r).toEqual({ ok: false, failure: 'rate_limited', detail: '17' });
  });

  it('409 says which side needs the update', async () => {
    const older = await harness({ reply: json(409, { error: 'protocol', supported: [0] }) }).client.ping(OWNER);
    expect(older).toEqual({ ok: false, failure: 'protocol', detail: 'remote_older' });
    const newer = await harness({ reply: json(409, { error: 'protocol', supported: [2, 3] }) }).client.ping(OWNER);
    expect(newer).toEqual({ ok: false, failure: 'protocol', detail: 'local_older' });
    const unknown = await harness({ reply: json(409, { error: 'protocol' }) }).client.ping(OWNER);
    expect(unknown).toMatchObject({ ok: false, failure: 'protocol' });
  });
});

describe('transport failures', () => {
  it('an oversize body (transport refusal) is too_large', async () => {
    const h = harness({ reply: () => { throw new ShareTransportError('too_large'); } });
    expect(await h.client.getBytes(OWNER, 'disks/d/bytes')).toMatchObject({ ok: false, failure: 'too_large' });
  });

  it('an oversize body a transport let through is still too_large', async () => {
    const h = harness({ reply: (req) => ({ status: 200, headers: PROTO, body: new Uint8Array(req.maxBytes + 1) }) });
    expect(await h.client.getBytes(OWNER, 'disks/d/bytes')).toMatchObject({ ok: false, failure: 'too_large' });
  });

  it('a certificate refusal is unreachable with detail certificate', async () => {
    const h = harness({ reply: () => { throw new ShareTransportError('certificate'); } });
    expect(await h.client.ping(OWNER)).toEqual({ ok: false, failure: 'unreachable', detail: 'certificate' });
  });

  it('a timeout or any other error is unreachable', async () => {
    expect(await harness({ reply: () => { throw new ShareTransportError('timeout'); } }).client.ping(OWNER))
      .toEqual({ ok: false, failure: 'unreachable', detail: 'timeout' });
    expect(await harness({ reply: () => { throw new Error('ECONNRESET'); } }).client.ping(OWNER))
      .toMatchObject({ ok: false, failure: 'unreachable' });
  });

  it('a resolver that never answers loses to the deadline', async () => {
    vi.useFakeTimers();
    try {
      const c = shareClient({ env: {}, resolve: () => new Promise(() => {}), transport: async () => json(200, {}) });
      const p = c.getJson(OWNER, 'library');
      await vi.advanceTimersByTimeAsync(SHARE_LIMITS.listing.timeoutMs + 1);
      expect(await p).toEqual({ ok: false, failure: 'unreachable', detail: 'timeout' });
    } finally { vi.useRealTimers(); }
  });
});

// ---------------------------------------------------------------- root pin (pure)

const b64sha = (der: Buffer) => createHash('sha256').update(der).digest('base64url');

let dir = '';
const certs: Record<string, X509Certificate> = {};
const pem: Record<string, string> = {};

function ossl(...args: string[]) {
  execFileSync('openssl', args, { cwd: dir, stdio: 'pipe' });
}

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'share-pin-'));
  const ec = ['-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:P-256', '-nodes'];
  writeFileSync(join(dir, 'ca.ext'), 'basicConstraints=critical,CA:TRUE\nkeyUsage=critical,keyCertSign,cRLSign\n');
  writeFileSync(join(dir, 'leaf.ext'), 'basicConstraints=CA:FALSE\nsubjectAltName=DNS:localhost,IP:127.0.0.1\n');
  const root = (name: string, cn: string) => ossl('req', '-x509', ...ec, '-subj', `/CN=${cn}`, '-days', '2',
    '-keyout', `${name}.key`, '-out', `${name}.crt`,
    '-addext', 'basicConstraints=critical,CA:TRUE', '-addext', 'keyUsage=critical,keyCertSign,cRLSign');
  const signed = (name: string, cn: string, ca: string, ext: string) => {
    ossl('req', ...ec, '-subj', `/CN=${cn}`, '-keyout', `${name}.key`, '-out', `${name}.csr`);
    ossl('x509', '-req', '-in', `${name}.csr`, '-CA', `${ca}.crt`, '-CAkey', `${ca}.key`, '-set_serial', String(Date.now() % 1e9),
      '-days', '1', '-extfile', ext, '-out', `${name}.crt`);
  };
  root('rootA', 'Test Root A');
  signed('inter', 'Test Intermediate', 'rootA', 'ca.ext');
  signed('leaf', 'localhost', 'inter', 'leaf.ext');
  root('rootB', 'Test Root B');
  // A different key under root A's NAME: what a forger can mint, since the real root A certificate is public.
  root('fakeA', 'Test Root A');
  signed('forgedLeaf', 'localhost', 'fakeA', 'leaf.ext');
  for (const n of ['rootA', 'inter', 'leaf', 'rootB', 'fakeA', 'forgedLeaf']) {
    pem[n] = readFileSync(join(dir, `${n}.crt`), 'utf8');
    certs[n] = new X509Certificate(pem[n]);
  }
  pem.leafKey = readFileSync(join(dir, 'leaf.key'), 'utf8');
  pem.forgedKey = readFileSync(join(dir, 'forgedLeaf.key'), 'utf8');
});

afterAll(() => { if (dir) rmSync(dir, { recursive: true, force: true }); });

describe('rootPinMatches', () => {
  it('matches a chain that ends in the pinned self-signed root', () => {
    const pinA = b64sha(certs.rootA.raw);
    expect(rootPinMatches([certs.leaf, certs.inter, certs.rootA], pinA)).toBe(true);
  });

  it('refuses a different root', () => {
    expect(rootPinMatches([certs.leaf, certs.inter, certs.rootA], b64sha(certs.rootB.raw))).toBe(false);
    expect(rootPinMatches([certs.rootB], b64sha(certs.rootA.raw))).toBe(false);
  });

  it('refuses a chain that stops before a self-signed root, even when the pin is the right one', () => {
    expect(rootPinMatches([certs.leaf, certs.inter], b64sha(certs.rootA.raw))).toBe(false);
    expect(rootPinMatches([certs.leaf, certs.inter], b64sha(certs.inter.raw))).toBe(false);
  });

  it('refuses a forged leaf presented with the real (public) root', () => {
    expect(certs.forgedLeaf.issuer).toBe(certs.rootA.subject);
    expect(rootPinMatches([certs.forgedLeaf, certs.rootA], b64sha(certs.rootA.raw))).toBe(false);
  });

  it('refuses a chain with a link skipped or out of order', () => {
    const pinA = b64sha(certs.rootA.raw);
    expect(rootPinMatches([certs.leaf, certs.rootA], pinA)).toBe(false);
    expect(rootPinMatches([certs.inter, certs.leaf, certs.rootA], pinA)).toBe(false);
  });

  it('refuses an expired chain', () => {
    const pinA = b64sha(certs.rootA.raw);
    expect(rootPinMatches([certs.leaf, certs.inter, certs.rootA], pinA, new Date(Date.now() + 5 * 86_400_000))).toBe(false);
  });

  it('refuses an empty chain and an empty pin', () => {
    expect(rootPinMatches([], b64sha(certs.rootA.raw))).toBe(false);
    expect(rootPinMatches([certs.rootA], '')).toBe(false);
  });
});

// ---------------------------------------------------------------- the real transport, against local servers

describe('nodeShareTransport', () => {
  const base = (url: string, extra: Partial<Req> = {}): Req => ({
    url: new URL(url), method: 'GET', headers: { accept: 'application/json' }, address: '127.0.0.1',
    pin: null, timeoutMs: 5_000, maxBytes: 1_000_000, ...extra,
  });

  async function tlsServer(certChain: string, key: string, handler: http.RequestListener) {
    const s = https.createServer({ cert: certChain, key }, handler);
    await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
    return { server: s, port: (s.address() as AddressInfo).port };
  }

  it('pinned: a chain ending in the pinned root connects', async () => {
    let seen = 0;
    const { server, port } = await tlsServer(pem.leaf + pem.inter + pem.rootA, pem.leafKey, (_q, res) => { seen++; res.end('ok'); });
    try {
      const r = await nodeShareTransport(base(`https://localhost:${port}/api/share/v1/ping`, { pin: b64sha(certs.rootA.raw) }));
      expect(r.status).toBe(200);
      expect(new TextDecoder().decode(r.body)).toBe('ok');
      expect(seen).toBe(1);
    } finally { server.close(); }
  });

  it('pinned: a wrong pin refuses before the request (and its token) is sent', async () => {
    let seen = 0;
    const { server, port } = await tlsServer(pem.leaf + pem.inter + pem.rootA, pem.leafKey, (_q, res) => { seen++; res.end('ok'); });
    try {
      const p = nodeShareTransport(base(`https://localhost:${port}/x`, {
        pin: b64sha(certs.rootB.raw), headers: { authorization: `Bearer ${TOKEN}` },
      }));
      await expect(p).rejects.toMatchObject({ kind: 'certificate' });
      expect(seen).toBe(0);
    } finally { server.close(); }
  });

  it('pinned: a leaf under the pinned root but for another host name is refused', async () => {
    let seen = 0;
    const { server, port } = await tlsServer(pem.leaf + pem.inter + pem.rootA, pem.leafKey, (_q, res) => { seen++; res.end('ok'); });
    try {
      await expect(nodeShareTransport(base(`https://other.example.com:${port}/x`, { pin: b64sha(certs.rootA.raw) })))
        .rejects.toMatchObject({ kind: 'certificate' });
      expect(seen).toBe(0);
    } finally { server.close(); }
  });

  it('pinned: a server that does not send its root (leaf + intermediate only) is refused', async () => {
    let seen = 0;
    const { server, port } = await tlsServer(pem.leaf + pem.inter, pem.leafKey, (_q, res) => { seen++; res.end('ok'); });
    try {
      await expect(nodeShareTransport(base(`https://localhost:${port}/x`, { pin: b64sha(certs.rootA.raw) })))
        .rejects.toMatchObject({ kind: 'certificate' });
      expect(seen).toBe(0);
    } finally { server.close(); }
  });

  it('pinned: a forged leaf shown with the real root is refused', async () => {
    let seen = 0;
    const { server, port } = await tlsServer(pem.forgedLeaf + pem.rootA, pem.forgedKey, (_q, res) => { seen++; res.end('ok'); });
    try {
      await expect(nodeShareTransport(base(`https://localhost:${port}/x`, { pin: b64sha(certs.rootA.raw) })))
        .rejects.toMatchObject({ kind: 'certificate' });
      expect(seen).toBe(0);
    } finally { server.close(); }
  });

  it('unpinned: a private CA is refused by ordinary verification', async () => {
    let seen = 0;
    const { server, port } = await tlsServer(pem.leaf + pem.inter + pem.rootA, pem.leafKey, (_q, res) => { seen++; res.end('ok'); });
    try {
      await expect(nodeShareTransport(base(`https://localhost:${port}/x`))).rejects.toBeTruthy();
      expect(seen).toBe(0);
    } finally { server.close(); }
  });

  describe('plain http (TEST_INSECURE only)', () => {
    let server: http.Server;
    let port = 0;
    const hits: { method?: string; url?: string; body: string; headers: http.IncomingHttpHeaders }[] = [];
    beforeAll(async () => {
      server = http.createServer((q, res) => {
        let body = '';
        q.on('data', (c) => { body += c; });
        q.on('end', () => {
          hits.push({ method: q.method, url: q.url, body, headers: q.headers });
          if (q.url === '/redirect') { res.writeHead(302, { location: 'http://127.0.0.1/' }); res.end(); return; }
          if (q.url === '/big') { res.end(Buffer.alloc(3000)); return; }
          if (q.url === '/big-chunked') { res.write(Buffer.alloc(800)); res.write(Buffer.alloc(800)); res.end(); return; }
          if (q.url === '/hang') return;
          res.writeHead(200, { 'X-WebFloppy-Share-Protocol': '1', ETag: '"abc"' });
          res.end('{"ok":true}');
        });
      });
      await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
      port = (server.address() as AddressInfo).port;
    });
    afterAll(() => { server.closeAllConnections(); server.close(); });

    it('connects to the given address, sends method, headers and body, lower-cases response headers', async () => {
      const r = await nodeShareTransport(base(`http://share.invalid:${port}/api/share/v1/claim`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"a":1}',
      }));
      expect(r.status).toBe(200);
      expect(r.headers['x-webfloppy-share-protocol']).toBe('1');
      expect(r.headers.etag).toBe('"abc"');
      const hit = hits.at(-1)!;
      expect(hit).toMatchObject({ method: 'POST', url: '/api/share/v1/claim', body: '{"a":1}' });
      expect(hit.headers.host).toBe(`share.invalid:${port}`);
    });

    it('returns a 302 as-is, never following it', async () => {
      const before = hits.length;
      const r = await nodeShareTransport(base(`http://127.0.0.1:${port}/redirect`));
      expect(r.status).toBe(302);
      expect(hits.length).toBe(before + 1);
    });

    it('abandons a body over maxBytes, declared or streamed', async () => {
      await expect(nodeShareTransport(base(`http://127.0.0.1:${port}/big`, { maxBytes: 1000 }))).rejects.toMatchObject({ kind: 'too_large' });
      await expect(nodeShareTransport(base(`http://127.0.0.1:${port}/big-chunked`, { maxBytes: 1000 }))).rejects.toMatchObject({ kind: 'too_large' });
    });

    it('times out a server that never answers', async () => {
      await expect(nodeShareTransport(base(`http://127.0.0.1:${port}/hang`, { timeoutMs: 200 }))).rejects.toMatchObject({ kind: 'timeout' });
    });
  });
});
