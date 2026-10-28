// The recipient's server calling an owner's share API (spec §3.3, §4.2, §5). SERVER ONLY.
//
// This is an outbound request to a host a user named (by pasting a link), so it is a server-side request forgery
// surface, guarded the way src/lib/url-fetch.ts guards upload-from-URL:
//   - The origin must be https (http only under WEBADF_SHARE_TEST_INSECURE=1, set by the e2e web server alone).
//   - The host is resolved HERE and EVERY address must be allowed: public always; private (RFC 1918, CGNAT, IPv6
//     ULA) only with WEBADF_SHARE_PRIVATE_ADDRESSES=1 (self-host default, two instances on one LAN); loopback only
//     under WEBADF_SHARE_TEST_INSECURE=1; link-local (cloud metadata), multicast, reserved never.
//   - The socket connects only to those vetted addresses (lookup pinned; all of them offered, so IPv6 can fall back
//     to IPv4); TLS still uses the real host name (SNI and, unpinned, ordinary certificate verification).
//   - Redirects are never followed: a 3xx is a bad response. Bodies are capped as they stream; one deadline per call.
//   - With a pin (the owner runs Caddy's internal CA, which does not send its root), the owner's Caddy serves that
//     root at /.well-known/webadf-root.pem. It is fetched (same address guard, unverified TLS for that one GET, no
//     token, 16 KB, no redirects), must be self-signed and hash to the pin, and the real request is then verified by
//     Node against exactly that root (`ca`) with the usual host-name check. Verified roots are cached 1 h per
//     (origin, pin). A wrong pin means the real request -- and the bearer token in it -- is never sent.
//   - Failures come back as a few coarse codes; nothing the remote said is passed through as text.

import http from 'node:http';
import https from 'node:https';
import { BlockList, isIP, type LookupFunction } from 'node:net';
import { createHash, X509Certificate } from 'node:crypto';
import { isPublicAddress, defaultResolver } from '@/lib/url-fetch';
import { MAX_DISK_BYTES } from '@/lib/blob-upload';
import { webadfUserAgent } from '@/lib/user-agent';
import { shareInsecureAllowed, SHARE_CODE_RE, type ShareEnv } from './link';
import { SHARE_PROTOCOL, SHARE_PROTOCOL_HEADER } from './types';

/**
 * Why a call came to nothing. 'token_unreadable' is never produced by this client: the recipient's store answers it
 * without calling, when the sealed token cannot be opened on this server (src/lib/remote/store.ts prepareRemote).
 */
export type ShareFailure =
  | 'unreachable' | 'ended' | 'protocol' | 'not_found' | 'rate_limited' | 'invalid_or_used' | 'too_large' | 'bad_response'
  | 'token_unreadable';
export type ShareResult<T> = { ok: true; value: T; etag?: string } | { ok: false; failure: ShareFailure; detail?: string };
export type ShareTarget = { origin: string; pin: string | null; token?: string };
export type ShareTransport = (req: {
  url: URL; method: 'GET' | 'POST'; headers: Record<string, string>; body?: string;
  address: string;
  /** Every vetted address for the host (`address` first). The socket may use only these; Node falls back between
   *  them (IPv6 to IPv4) as it does for an ordinary name. Absent: `address` alone. */
  addresses?: { address: string; family: 4 | 6 }[];
  /** PEM of the only root to trust (a pinned owner); null = the system's roots. */
  ca: string | null;
  /** Skip certificate verification. ONLY for fetching the root PEM that is then checked against the pin. */
  insecureTls?: boolean;
  timeoutMs: number; maxBytes: number;
  /** Aborted when the caller gave up (its deadline won the race): close the socket now. */
  signal?: AbortSignal;
}) => Promise<{ status: number; headers: Record<string, string>; body: Uint8Array }>;

/**
 * Spec §5 / global constraints: listings 2 MB in 10 s; bytes the largest disk the app accepts in 45 s. Mount, Send
 * and Download make a listing call and a bytes call inside one function run (maxDuration 60): 10 + 45 leaves room
 * to answer a slow owner as a clean 502 unreachable before the platform kills the function (final review 5).
 */
export const SHARE_LIMITS = {
  listing: { maxBytes: 2 * 1024 * 1024, timeoutMs: 10_000 },
  bytes: { maxBytes: MAX_DISK_BYTES, timeoutMs: 45_000 },
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

/** Where an owner's Caddy serves its internal root (Task 10 adds it to the Caddyfile). */
export const ROOT_PEM_PATH = '/.well-known/webadf-root.pem';
const ROOT_PEM_MAX_BYTES = 16 * 1024;
const ROOT_CACHE_MS = 60 * 60 * 1000;

/**
 * The pin of a self-signed CA certificate in `pem` (base64url SHA-256 of its DER), or null when it is not one.
 * Exactly ONE certificate: X509Certificate parses only the first, while `ca: [pem]` would trust every one in the
 * string -- a second, attacker-owned root riding behind the real one would otherwise pass the pin.
 */
export function pinOfRootPem(pem: string): string | null {
  if (typeof pem !== 'string' || (pem.match(/-----BEGIN/g) ?? []).length !== 1) return null;
  try {
    const c = new X509Certificate(pem);
    if (!c.ca || !c.checkIssued(c) || !c.verify(c.publicKey)) return null;
    const now = new Date();
    if (new Date(c.validFrom) > now || now > new Date(c.validTo)) return null;
    return createHash('sha256').update(c.raw).digest('base64url');
  } catch {
    return null;
  }
}

/** True when `pem` is exactly one self-signed CA certificate whose pin is `pin`. */
export function rootPemMatchesPin(pem: string, pin: string): boolean {
  return !!pin && pinOfRootPem(pem) === pin;
}

/** Verified roots, per `${origin} ${pin}`. In memory, per function instance. */
const rootCache = new Map<string, { pem: string; expires: number }>();

/** Tests only. */
export function clearShareRootCache(): void {
  rootCache.clear();
}

// ------------------------------------------------------------ the transport

/**
 * node:http(s) to the vetted address: agent:false, lookup pinned, servername = the real host, so the certificate is
 * verified for the name the link gave (an IP origin is checked against the certificate's IP SANs). `ca` replaces the
 * system roots with the one pinned root. `insecureTls` is only ever set for the root-PEM fetch. Plain http only
 * reaches here when the client allowed it (WEBADF_SHARE_TEST_INSECURE=1).
 */
export const nodeShareTransport: ShareTransport = (req) => new Promise((resolve, reject) => {
  const isHttps = req.url.protocol === 'https:';
  const host = bareHost(req.url);
  const port = Number(req.url.port || (isHttps ? 443 : 80));
  const family: 4 | 6 = isIP(req.address) === 6 ? 6 : 4;
  const servername = isIP(host) ? undefined : host;
  // Every address on offer was vetted (vetHost); the socket is only ever given these, so Node's autoSelectFamily
  // can fall back from an unreachable IPv6 address to IPv4 (as src/lib/url-fetch.ts nodeTransport does).
  const offered = req.addresses && req.addresses.length > 0 ? req.addresses : [{ address: req.address, family }];
  const pinned: LookupFunction = (_hostname, options, cb) => {
    if (options && (options as { all?: boolean }).all) {
      (cb as unknown as (e: null, a: { address: string; family: number }[]) => void)(null, offered.map((a) => ({ ...a })));
    } else {
      cb(null, offered[0].address, offered[0].family);
    }
  };

  let settled = false;
  let request: http.ClientRequest | null = null;
  const fail = (e: unknown) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    request?.destroy();
    if (e instanceof ShareTransportError) { reject(e); return; }
    const code = String((e as { code?: unknown })?.code ?? '');
    // Node/OpenSSL certificate failures: untrusted chain, wrong host name, expired, self-signed.
    const kind = /CERT|SIGNATURE|ISSUER|ALTNAME|SELF_SIGNED/.test(code) ? 'certificate' : 'network';
    reject(new ShareTransportError(kind, e instanceof Error ? e.message : String(e)));
  };
  const timer = setTimeout(() => fail(new ShareTransportError('timeout')), req.timeoutMs);
  if (req.signal) {
    if (req.signal.aborted) { fail(new ShareTransportError('timeout')); return; }
    req.signal.addEventListener('abort', () => fail(new ShareTransportError('timeout')), { once: true });
  }

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

  options.agent = false;
  options.lookup = pinned;
  if (isHttps) {
    if (servername) options.servername = servername;
    if (req.insecureTls) {
      // Only for the root PEM, which is then checked against the pin before anything is trusted or sent.
      // nosemgrep: problem-based-packs.insecure-transport.js-node.bypass-tls-verification.bypass-tls-verification
      options.rejectUnauthorized = false;
    } else if (req.ca) {
      options.ca = [req.ca];
    }
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

/** One deadline per call: rejects `deadline` and aborts `signal` (closing any socket) when the time is up. */
function makeDeadline(ms: number) {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, rej) => {
    timer = setTimeout(() => { controller.abort(); rej(new ShareTransportError('timeout')); }, ms);
  });
  deadline.catch(() => {});
  return {
    deadline,
    signal: controller.signal,
    /** Stop the clock and close whatever a lost race left open. */
    done: () => { clearTimeout(timer); controller.abort(); },
  };
}

/** Where to connect for `url`, or why not. DNS is raced against the call's deadline. */
async function vetHost(
  resolve: typeof defaultResolver, url: URL, p: Policy, deadline: Promise<never>,
): Promise<{ ok: true; address: string; addresses: { address: string; family: 4 | 6 }[] } | Fail> {
  const host = bareHost(url);
  if (isIP(host)) {
    return addressAllowed(host, p)
      ? { ok: true, address: host, addresses: [{ address: host, family: isIP(host) === 6 ? 6 : 4 }] }
      : failure('unreachable', 'address_not_allowed');
  }
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
  return { ok: true, address: addrs[0].address, addresses: addrs.map((a) => ({ address: a.address, family: a.family === 6 ? 6 : 4 })) };
}

const ROOT_PEM_HEADERS = () => ({ 'user-agent': webadfUserAgent(), accept: 'application/x-pem-file, */*', 'accept-encoding': 'identity' });

export function shareClient(deps: { resolve?: typeof defaultResolver; transport?: ShareTransport; env?: ShareEnv } = {}) {
  const resolve = deps.resolve ?? defaultResolver;
  const transport = deps.transport ?? nodeShareTransport;
  const env = deps.env ?? process.env;

  /** The pinned root's PEM for this origin, fetched and checked against the pin, or the failure. Never sends a token. */
  async function pinnedRoot(
    origin: URL, pin: string, where: { address: string; addresses: { address: string; family: 4 | 6 }[] },
    deadline: Promise<never>, signal: AbortSignal, timeoutMs: number,
  ): Promise<{ ok: true; pem: string } | Fail> {
    const key = `${origin.origin} ${pin}`;
    const hit = rootCache.get(key);
    if (hit && hit.expires > Date.now()) return { ok: true, pem: hit.pem };
    let res: Awaited<ReturnType<ShareTransport>>;
    try {
      res = await Promise.race([
        transport({
          url: new URL(ROOT_PEM_PATH, origin), method: 'GET',
          headers: ROOT_PEM_HEADERS(),
          address: where.address, addresses: where.addresses, ca: null, insecureTls: true, timeoutMs, maxBytes: ROOT_PEM_MAX_BYTES, signal,
        }),
        deadline,
      ]);
    } catch (e) {
      if (e instanceof ShareTransportError && e.kind !== 'too_large' && e.kind !== 'certificate') return failure('unreachable', e.kind);
      if (!(e instanceof ShareTransportError)) return failure('unreachable', 'network');
      return failure('unreachable', 'certificate');
    }
    if (res.status >= 500) return failure('unreachable', `status_${res.status}`);
    if (res.status !== 200 || !(res.body instanceof Uint8Array) || res.body.byteLength > ROOT_PEM_MAX_BYTES) {
      return failure('unreachable', 'certificate');
    }
    const pem = new TextDecoder().decode(res.body);
    if (!rootPemMatchesPin(pem, pin)) return failure('unreachable', 'certificate');
    // Trust exactly the certificate that was verified, re-encoded -- never the served text as such.
    const one = new X509Certificate(pem).toString();
    rootCache.set(key, { pem: one, expires: Date.now() + ROOT_CACHE_MS });
    return { ok: true, pem: one };
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

    const { deadline, signal, done } = makeDeadline(o.limits.timeoutMs);
    try {
      const where = await vetHost(resolve, url, p, deadline);
      if (!where.ok) return where;

      let ca: string | null = null;
      // A pin on an http origin has no TLS to pin; vetOrigin only lets http through under WEBADF_SHARE_TEST_INSECURE=1.
      if (t.pin && url.protocol === 'https:') {
        const root = await pinnedRoot(origin.url, t.pin, where, deadline, signal, o.limits.timeoutMs);
        if (!root.ok) return root;
        ca = root.pem;
      }

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
          transport({
            url, method, headers, body: o.body, address: where.address, addresses: where.addresses, ca,
            timeoutMs: o.limits.timeoutMs, maxBytes: o.limits.maxBytes, signal,
          }),
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
      done();
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

/**
 * The pin for `origin`'s own internal root (Task 4: the owner's instance pins itself into its links). Fetches
 * <origin>/.well-known/webadf-root.pem through the guarded transport (unverified TLS, no token). Returns null when
 * that URL answers 404 -- an instance with a publicly trusted certificate serves no such file. Throws on anything
 * else (unreachable, refused address, not a self-signed CA), so the caller can tell "no pin needed" from "broken".
 */
export async function fetchLocalRootPin(
  origin: string,
  deps: { resolve?: typeof defaultResolver; transport?: ShareTransport; env?: ShareEnv } = {},
): Promise<string | null> {
  const resolve = deps.resolve ?? defaultResolver;
  const transport = deps.transport ?? nodeShareTransport;
  const p = policyFrom(deps.env ?? process.env);
  const o = vetOrigin(origin, p);
  if (!o.ok) throw new Error(`root pin: ${o.detail ?? o.failure}`);
  if (o.url.protocol !== 'https:') return null;
  const timeoutMs = SHARE_LIMITS.listing.timeoutMs;
  const { deadline, signal, done } = makeDeadline(timeoutMs);
  let res: Awaited<ReturnType<ShareTransport>>;
  try {
    const where = await vetHost(resolve, o.url, p, deadline);
    if (!where.ok) throw new Error(`root pin: ${where.detail ?? where.failure}`);
    res = await Promise.race([
      transport({
        url: new URL(ROOT_PEM_PATH, o.url), method: 'GET', headers: ROOT_PEM_HEADERS(),
        address: where.address, addresses: where.addresses, ca: null, insecureTls: true, timeoutMs, maxBytes: ROOT_PEM_MAX_BYTES, signal,
      }),
      deadline,
    ]);
  } finally {
    done();
  }
  if (res.status === 404) return null;
  if (res.status !== 200) throw new Error(`root pin: status_${res.status}`);
  const pin = pinOfRootPem(new TextDecoder().decode(res.body));
  if (!pin) throw new Error('root pin: not a self-signed CA certificate');
  return pin;
}
