// The recipient's server calling an owner's share API (spec §3.3, §4.2, §5). SERVER ONLY.
//
// This is an outbound request to a host a user named (by pasting a link), so it is a server-side request forgery
// surface, guarded the way src/lib/url-fetch.ts guards upload-from-URL:
//   - The origin must be https (http only under WEBADF_SHARE_TEST_INSECURE=1, set by the e2e web server alone).
//   - The host is resolved HERE and EVERY address must be allowed: public always; private (RFC 1918, CGNAT, IPv6
//     ULA) only with WEBADF_SHARE_PRIVATE_ADDRESSES=1 (self-host default, two instances on one LAN); loopback only
//     under WEBADF_SHARE_TEST_INSECURE=1; link-local (cloud metadata), multicast, reserved never.
//   - The socket connects to that vetted address (lookup pinned); TLS still uses the real host name (SNI and,
//     unpinned, ordinary certificate verification).
//   - Redirects are never followed: a 3xx is a bad response. Bodies are capped as they stream; one deadline per call.
//   - With a pin (the owner runs Caddy's internal CA), the TLS chain must end in exactly the pinned self-signed root,
//     verified signature by signature, and the leaf must name the host, BEFORE the request -- and the bearer token
//     in it -- is written.
//   - Failures come back as a few coarse codes; nothing the remote said is passed through as text.

import http from 'node:http';
import https from 'node:https';
import tls from 'node:tls';
import { BlockList, isIP, type LookupFunction, type Socket } from 'node:net';
import { createHash, X509Certificate } from 'node:crypto';
import { isPublicAddress, defaultResolver } from '@/lib/url-fetch';
import { MAX_DISK_BYTES } from '@/lib/blob-upload';
import { webadfUserAgent } from '@/lib/user-agent';
import { shareInsecureAllowed, SHARE_CODE_RE, type ShareEnv } from './link';
import { SHARE_PROTOCOL, SHARE_PROTOCOL_HEADER } from './types';

export type ShareFailure =
  | 'unreachable' | 'ended' | 'protocol' | 'not_found' | 'rate_limited' | 'invalid_or_used' | 'too_large' | 'bad_response';
export type ShareResult<T> = { ok: true; value: T; etag?: string } | { ok: false; failure: ShareFailure; detail?: string };
export type ShareTarget = { origin: string; pin: string | null; token?: string };
export type ShareTransport = (req: {
  url: URL; method: 'GET' | 'POST'; headers: Record<string, string>; body?: string;
  address: string; pin: string | null; timeoutMs: number; maxBytes: number;
}) => Promise<{ status: number; headers: Record<string, string>; body: Uint8Array }>;

/** Spec §5 / global constraints: listings 2 MB in 10 s; bytes the largest disk the app accepts in 60 s. */
export const SHARE_LIMITS = {
  listing: { maxBytes: 2 * 1024 * 1024, timeoutMs: 10_000 },
  bytes: { maxBytes: MAX_DISK_BYTES, timeoutMs: 60_000 },
} as const;

const API_PREFIX = '/api/share/v1/';
const PROTOCOL_HEADER = SHARE_PROTOCOL_HEADER.toLowerCase();

/** What a transport throws for the failures the client must tell apart. Anything else thrown is 'network'. */
export class ShareTransportError extends Error {
  constructor(readonly kind: 'too_large' | 'certificate' | 'timeout' | 'network', message?: string) {
    super(message ?? kind);
    this.name = 'ShareTransportError';
  }
}

// ------------------------------------------------------------ address policy

/** Ranges a self-hosted instance may reach on its own LAN (WEBADF_SHARE_PRIVATE_ADDRESSES=1). Link-local is NOT
 *  here: 169.254.169.254 is the cloud metadata endpoint. BlockList also matches IPv4-mapped IPv6 against these. */
const PRIVATE = new BlockList();
PRIVATE.addSubnet('10.0.0.0', 8, 'ipv4');
PRIVATE.addSubnet('172.16.0.0', 12, 'ipv4');
PRIVATE.addSubnet('192.168.0.0', 16, 'ipv4');
PRIVATE.addSubnet('100.64.0.0', 10, 'ipv4');
PRIVATE.addSubnet('fc00::', 7, 'ipv6');

const LOOPBACK = new BlockList();
LOOPBACK.addSubnet('127.0.0.0', 8, 'ipv4');
LOOPBACK.addAddress('::1', 'ipv6');

export type AddressClass = 'public' | 'private' | 'loopback' | 'refused';

export function classifyAddress(ip: string): AddressClass {
  if (isPublicAddress(ip)) return 'public';
  const kind = isIP(ip);
  if (kind === 0 || ip.includes('%')) return 'refused';
  const type = kind === 6 ? 'ipv6' : 'ipv4';
  if (LOOPBACK.check(ip, type)) return 'loopback';
  if (PRIVATE.check(ip, type)) return 'private';
  return 'refused';
}

type Policy = { privateOk: boolean; loopbackOk: boolean; httpOk: boolean };

function policyFrom(env: ShareEnv): Policy {
  const insecure = shareInsecureAllowed(env);
  return { privateOk: env.WEBADF_SHARE_PRIVATE_ADDRESSES === '1', loopbackOk: insecure, httpOk: insecure };
}

function addressAllowed(ip: string, p: Policy): boolean {
  switch (classifyAddress(ip)) {
    case 'public': return true;
    case 'private': return p.privateOk;
    case 'loopback': return p.loopbackOk;
    default: return false;
  }
}

function bareHost(url: URL): string {
  const h = url.hostname;
  return h.startsWith('[') && h.endsWith(']') ? h.slice(1, -1) : h;
}

// ------------------------------------------------------------ root pin

function validNow(c: X509Certificate, now: Date): boolean {
  return new Date(c.validFrom) <= now && now <= new Date(c.validTo);
}

/**
 * True when `chain` (leaf first, as the server presented it) is a real chain -- each certificate issued AND signed by
 * the next, every issuer a CA, all valid now -- ending in a self-signed root whose DER hashes (SHA-256, base64url) to
 * `pin`. A chain that stops short of a self-signed root never matches, even if the pin is right: the root's
 * certificate is public, so only a verified signature path to it proves anything.
 */
export function rootPinMatches(chain: X509Certificate[], pin: string, now: Date = new Date()): boolean {
  if (!pin || chain.length === 0 || chain.length > 10) return false;
  try {
    for (let i = 0; i < chain.length; i++) {
      const c = chain[i];
      if (!validNow(c, now)) return false;
      const issuer = i + 1 < chain.length ? chain[i + 1] : c;
      if (i > 0 && !c.ca) return false;
      if (!c.checkIssued(issuer) || !c.verify(issuer.publicKey)) return false;
    }
    const root = chain[chain.length - 1];
    return createHash('sha256').update(root.raw).digest('base64url') === pin;
  } catch {
    return false;
  }
}

/** The presented chain, leaf first, from a connected TLS socket. */
function peerChain(sock: tls.TLSSocket): X509Certificate[] {
  const out: X509Certificate[] = [];
  let c: tls.DetailedPeerCertificate | undefined = sock.getPeerCertificate(true);
  const seen = new Set<string>();
  while (c && c.raw && out.length < 10) {
    const fp = c.fingerprint256;
    if (seen.has(fp)) break; // a self-signed root points at itself
    seen.add(fp);
    out.push(new X509Certificate(c.raw));
    c = c.issuerCertificate;
  }
  return out;
}

// ------------------------------------------------------------ the transport

/**
 * node:http(s) to the vetted address. Unpinned https: agent:false, lookup pinned, servername = the real host, so the
 * certificate is verified for the name the link gave. Pinned: the TLS socket is made here with
 * rejectUnauthorized:false, the chain is checked against the pin on secureConnect, and only then is the socket handed
 * to the request -- nothing (no token) is written to a server that fails the pin. Plain http only reaches here when
 * the client allowed it (WEBADF_SHARE_TEST_INSECURE=1).
 */
export const nodeShareTransport: ShareTransport = (req) => new Promise((resolve, reject) => {
  const isHttps = req.url.protocol === 'https:';
  const host = bareHost(req.url);
  const port = Number(req.url.port || (isHttps ? 443 : 80));
  const family = isIP(req.address) === 6 ? 6 : 4;
  const servername = isIP(host) ? undefined : host;
  const pinned: LookupFunction = (_hostname, options, cb) => {
    if (options && (options as { all?: boolean }).all) {
      (cb as unknown as (e: null, a: { address: string; family: number }[]) => void)(null, [{ address: req.address, family }]);
    } else {
      cb(null, req.address, family);
    }
  };

  let settled = false;
  let request: http.ClientRequest | null = null;
  const fail = (e: unknown) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    request?.destroy();
    reject(e instanceof ShareTransportError ? e : new ShareTransportError('network', e instanceof Error ? e.message : String(e)));
  };
  const timer = setTimeout(() => fail(new ShareTransportError('timeout')), req.timeoutMs);

  const headers: Record<string, string> = { ...req.headers };
  if (req.body !== undefined) headers['content-length'] = String(Buffer.byteLength(req.body));

  const options: https.RequestOptions = {
    protocol: req.url.protocol,
    hostname: host,
    port,
    path: `${req.url.pathname}${req.url.search}`,
    method: req.method,
    headers,
  };

  if (isHttps && req.pin) {
    const pin = req.pin;
    // No agent: ClientRequest then calls createConnection with a callback, and waits for it.
    options.createConnection = ((_opts: unknown, oncreate: (err: Error | null, socket?: Socket) => void) => {
      // CA verification is replaced, not dropped: rootPinMatches + checkServerIdentity below run before any write.
      // nosemgrep: problem-based-packs.insecure-transport.js-node.bypass-tls-verification.bypass-tls-verification
      const sock = tls.connect({ host: req.address, port, servername, rejectUnauthorized: false, ALPNProtocols: ['http/1.1'] });
      let done = false;
      sock.once('secureConnect', () => {
        if (done) return;
        done = true;
        let good = false;
        try {
          // The pinned root vouches for the chain; the leaf must still be for the host the link named.
          good = rootPinMatches(peerChain(sock), pin) && tls.checkServerIdentity(host, sock.getPeerCertificate()) === undefined;
        } catch { good = false; }
        if (!good) {
          sock.destroy();
          fail(new ShareTransportError('certificate'));
          return;
        }
        oncreate(null, sock);
      });
      sock.once('error', (e) => {
        if (done) return;
        done = true;
        fail(e);
      });
      return undefined;
    }) as unknown as https.RequestOptions['createConnection'];
  } else {
    options.agent = false;
    options.lookup = pinned;
    if (isHttps && servername) options.servername = servername;
  }

  const r = (isHttps ? https : http).request(options);
  request = r;
  r.on('error', fail);
  r.on('response', (res) => {
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(res.headers)) {
      if (v !== undefined) out[k.toLowerCase()] = Array.isArray(v) ? v[0] : v;
    }
    const claimed = Number(out['content-length']);
    if (Number.isFinite(claimed) && claimed > req.maxBytes) { fail(new ShareTransportError('too_large')); return; }
    const chunks: Buffer[] = [];
    let total = 0;
    res.on('data', (chunk: Buffer) => {
      total += chunk.byteLength;
      if (total > req.maxBytes) { fail(new ShareTransportError('too_large')); return; }
      chunks.push(chunk);
    });
    res.on('error', fail);
    res.on('aborted', () => fail(new ShareTransportError('network', 'aborted')));
    res.on('end', () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ status: res.statusCode ?? 0, headers: out, body: new Uint8Array(Buffer.concat(chunks, total)) });
    });
  });
  r.end(req.body);
});

// ------------------------------------------------------------ the client

type Fail = { ok: false; failure: ShareFailure; detail?: string };
const failure = (f: ShareFailure, detail?: string): Fail => (detail === undefined ? { ok: false, failure: f } : { ok: false, failure: f, detail });

type Raw = { ok: true; headers: Record<string, string>; body: Uint8Array };

function parseJson(body: Uint8Array): unknown {
  try { return JSON.parse(new TextDecoder().decode(body)); } catch { return undefined; }
}

/** Strip a weak marker and the quotes: the owner sends `ETag: "<sha256>"`. */
function unquoteEtag(v: string | undefined): string | undefined {
  if (!v) return undefined;
  const s = v.trim().replace(/^W\//, '');
  return s.startsWith('"') && s.endsWith('"') && s.length >= 2 ? s.slice(1, -1) : s;
}

/** A path under /api/share/v1/, or null when it would escape it. */
function apiUrl(origin: URL, path: string): URL | null {
  if (typeof path !== 'string' || path === '' || path.includes('#')) return null;
  // The path part may not climb or restart; the query (a search for "AC/DC") is free text.
  const pathPart = path.split('?', 1)[0];
  if (pathPart === '' || pathPart.startsWith('/') || /\\|%2e|%2f|%5c|^[a-z][a-z0-9+.-]*:/i.test(pathPart)) return null;
  if (pathPart.split('/').some((seg) => seg === '.' || seg === '..')) return null;
  let url: URL;
  try { url = new URL(API_PREFIX + path, origin); } catch { return null; }
  if (url.origin !== origin.origin || !url.pathname.startsWith(API_PREFIX) || url.pathname.split('/').includes('..')) return null;
  return url;
}

function vetOrigin(raw: string, p: Policy): { ok: true; url: URL } | Fail {
  let url: URL;
  try { url = new URL(raw); } catch { return failure('unreachable', 'origin'); }
  if (url.protocol !== 'https:' && !(p.httpOk && url.protocol === 'http:')) return failure('unreachable', 'scheme');
  if (url.username !== '' || url.password !== '' || url.hostname === '') return failure('unreachable', 'origin');
  if ((url.pathname !== '/' && url.pathname !== '') || url.search !== '' || url.hash !== '') return failure('unreachable', 'origin');
  return { ok: true, url };
}

export function shareClient(deps: { resolve?: typeof defaultResolver; transport?: ShareTransport; env?: ShareEnv } = {}) {
  const resolve = deps.resolve ?? defaultResolver;
  const transport = deps.transport ?? nodeShareTransport;
  const env = deps.env ?? process.env;

  async function vetHost(url: URL, p: Policy, deadline: Promise<never>): Promise<{ ok: true; address: string } | Fail> {
    const host = bareHost(url);
    if (isIP(host)) return addressAllowed(host, p) ? { ok: true, address: host } : failure('unreachable', 'address_not_allowed');
    const lower = host.toLowerCase().replace(/\.$/, '');
    if ((lower === 'localhost' || lower.endsWith('.localhost')) && !p.loopbackOk) return failure('unreachable', 'address_not_allowed');
    let addrs;
    try {
      addrs = await Promise.race([resolve(host), deadline]);
    } catch (e) {
      return failure('unreachable', e instanceof ShareTransportError ? e.kind : 'dns');
    }
    if (!addrs || addrs.length === 0) return failure('unreachable', 'dns');
    // ALL of them: a name with one allowed and one refused record is somebody arranging to reach the refused one.
    if (!addrs.every((a) => addressAllowed(a.address, p))) return failure('unreachable', 'address_not_allowed');
    return { ok: true, address: addrs[0].address };
  }

  async function call(
    t: ShareTarget, method: 'GET' | 'POST', path: string,
    o: { limits: { maxBytes: number; timeoutMs: number }; accept: string; body?: string; auth: boolean },
  ): Promise<Raw | Fail> {
    const p = policyFrom(env);
    const origin = vetOrigin(t.origin, p);
    if (!origin.ok) return origin;
    const url = apiUrl(origin.url, path);
    if (!url) return failure('bad_response', 'path');

    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_, rej) => { timer = setTimeout(() => rej(new ShareTransportError('timeout')), o.limits.timeoutMs); });
    deadline.catch(() => {});
    try {
      const where = await vetHost(url, p, deadline);
      if (!where.ok) return where;

      const headers: Record<string, string> = {
        'user-agent': webadfUserAgent(),
        accept: o.accept,
        // Raw bytes only: the cap must count what we hold, and a gzip body would need a bomb guard.
        'accept-encoding': 'identity',
        [PROTOCOL_HEADER]: String(SHARE_PROTOCOL),
      };
      if (o.body !== undefined) headers['content-type'] = 'application/json';
      if (o.auth && t.token) headers.authorization = `Bearer ${t.token}`;

      let res: Awaited<ReturnType<ShareTransport>>;
      try {
        res = await Promise.race([
          transport({ url, method, headers, body: o.body, address: where.address, pin: t.pin, timeoutMs: o.limits.timeoutMs, maxBytes: o.limits.maxBytes }),
          deadline,
        ]);
      } catch (e) {
        if (e instanceof ShareTransportError) {
          if (e.kind === 'too_large') return failure('too_large');
          return failure('unreachable', e.kind);
        }
        return failure('unreachable', 'network');
      }

      const h: Record<string, string> = {};
      for (const [k, v] of Object.entries(res.headers ?? {})) h[k.toLowerCase()] = v;
      const status = res.status;
      if (status >= 300 && status < 400) return failure('bad_response', 'redirect');
      if (status >= 500) return failure('unreachable', `status_${status}`);
      if (!/^\d+$/.test((h[PROTOCOL_HEADER] ?? '').trim())) return failure('bad_response', 'protocol_header');
      if (!(res.body instanceof Uint8Array) || res.body.byteLength > o.limits.maxBytes) return failure('too_large');

      if (status === 200) return { ok: true, headers: h, body: res.body };
      if (status === 401) return failure('ended');
      if (status === 404) {
        const b = parseJson(res.body) as { error?: unknown } | undefined;
        return failure(b && b.error === 'invalid_or_used' ? 'invalid_or_used' : 'not_found');
      }
      if (status === 409) {
        const b = parseJson(res.body) as { supported?: unknown } | undefined;
        const nums = Array.isArray(b?.supported) ? b.supported.filter((n): n is number => typeof n === 'number') : [];
        if (nums.length === 0) return failure('protocol');
        return failure('protocol', Math.max(...nums) < SHARE_PROTOCOL ? 'remote_older' : 'local_older');
      }
      if (status === 429) return failure('rate_limited', h['retry-after']);
      return failure('bad_response', `status_${status}`);
    } catch {
      return failure('unreachable', 'network');
    } finally {
      clearTimeout(timer);
    }
  }

  async function getJsonAt<T>(t: ShareTarget, path: string, auth: boolean): Promise<ShareResult<T>> {
    const r = await call(t, 'GET', path, { limits: SHARE_LIMITS.listing, accept: 'application/json', auth });
    if (!r.ok) return r;
    const v = parseJson(r.body);
    if (v === undefined) return failure('bad_response', 'json');
    return { ok: true, value: v as T };
  }

  return {
    async ping(t: ShareTarget): Promise<ShareResult<{ protocol: number }>> {
      const r = await getJsonAt<{ protocol?: unknown }>(t, 'ping', false);
      if (!r.ok) return r;
      const proto = r.value?.protocol;
      if (typeof proto !== 'number' || !Number.isInteger(proto)) return failure('bad_response', 'json');
      return { ok: true, value: { protocol: proto } };
    },

    async claim(t: ShareTarget, code: string, me: { instanceUrl: string; instanceName: string })
      : Promise<ShareResult<{ token: string; library: { name: string } }>> {
      if (typeof code !== 'string' || !SHARE_CODE_RE.test(code)) return failure('invalid_or_used');
      const body = JSON.stringify({ code, protocol: SHARE_PROTOCOL, instanceUrl: me.instanceUrl, instanceName: me.instanceName });
      const r = await call(t, 'POST', 'claim', { limits: SHARE_LIMITS.listing, accept: 'application/json', body, auth: false });
      if (!r.ok) return r;
      const v = parseJson(r.body) as { token?: unknown; protocol?: unknown; library?: { name?: unknown } } | undefined;
      if (!v || typeof v !== 'object' || typeof v.token !== 'string' || !/^wfst_[A-Za-z0-9_-]{43}$/.test(v.token)
        || v.protocol !== SHARE_PROTOCOL || !v.library || typeof v.library.name !== 'string') {
        return failure('bad_response', 'json');
      }
      return { ok: true, value: { token: v.token, library: { name: v.library.name } } };
    },

    getJson<T>(t: ShareTarget, path: string): Promise<ShareResult<T>> {
      return getJsonAt<T>(t, path, true);
    },

    async getBytes(t: ShareTarget, path: string): Promise<ShareResult<Uint8Array>> {
      const r = await call(t, 'GET', path, { limits: SHARE_LIMITS.bytes, accept: '*/*', auth: true });
      if (!r.ok) return r;
      const etag = unquoteEtag(r.headers.etag);
      return etag === undefined ? { ok: true, value: r.body } : { ok: true, value: r.body, etag };
    },
  };
}

export type ShareClient = ReturnType<typeof shareClient>;
