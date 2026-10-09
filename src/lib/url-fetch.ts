// Fetching a URL a user pasted, from inside our own network position.
//
// This is a server-side request forgery surface: whatever the user names, the
// SERVER connects to. Everything here exists so that "the server" can only
// ever mean "a public host on the internet", never our own loopback, the
// cloud metadata endpoint (169.254.169.254), a private network or anything
// that resolves to one of those.
//
// The rules, each enforced below and tested in url-fetch.test.ts:
//   - http and https only; no user:password@ in the URL; ports 80 and 443 only.
//   - The host is resolved HERE, every address it resolves to must be public,
//     and the connection is made to that vetted address (pinned through the
//     socket's lookup), so a DNS-rebinding second answer is never consulted.
//   - Redirects are followed by hand, at most MAX_REDIRECTS, and every hop is
//     vetted exactly like the first.
//   - The body is counted as it streams and abandoned past maxBytes, whatever
//     Content-Length claimed; the whole fetch has one deadline.
//   - Failures come back as coarse codes. Nothing the upstream said (body,
//     headers, error text) is ever handed to the caller to show.
//
// The resolver and the transport are injectable so all of this is testable
// without a network.

import http from 'node:http';
import https from 'node:https';
import { isIP } from 'node:net';
import { lookup as dnsLookup } from 'node:dns/promises';
import type { LookupFunction } from 'node:net';

export const URL_FETCH_LIMITS = {
  /** A disk image is at most 2.5 MiB (MAX_DISK_BYTES); a .zip of a whole
   *  multi-disk release is a few MB. 20 MiB leaves room for a large set while
   *  bounding what one request can make the function hold in memory. */
  maxBytes: 20 * 1024 * 1024,
  maxRedirects: 3,
  /** For the whole fetch, every hop and the body included. The route's
   *  budget is 60 s and storing + registering needs the rest. */
  timeoutMs: 25_000,
  maxUrlLength: 2048,
} as const;

export type UrlFetchLimits = { -readonly [K in keyof typeof URL_FETCH_LIMITS]: number };

/** Ports a URL may name. Explicit ports are an internal-service probing tool
 *  far more often than a real download host; 80/443 are what public file
 *  hosts use. */
export const ALLOWED_PORTS = new Set([80, 443]);

export type UrlFetchCode =
  | 'invalid_url'
  | 'unsupported_scheme'
  | 'credentials_not_allowed'
  | 'port_not_allowed'
  | 'address_not_allowed'
  | 'unreachable'
  | 'too_many_redirects'
  | 'upstream_status'
  | 'too_large'
  | 'timeout';

export type UrlFetchResult =
  | { ok: true; bytes: Uint8Array; finalUrl: URL; contentDisposition: string | null }
  | { ok: false; code: UrlFetchCode; /** Only for upstream_status: the public host's HTTP status. */ status?: number };

export type ResolvedAddress = { address: string; family: 4 | 6 };
export type Resolver = (hostname: string) => Promise<ResolvedAddress[]>;

export interface TransportRequest {
  url: URL;
  /** The vetted address to connect to. The transport MUST NOT resolve the host itself. */
  address: string;
  family: 4 | 6;
  headers: Record<string, string>;
  signal: AbortSignal;
}
export interface TransportResponse {
  status: number;
  /** Lower-cased names. */
  headers: Record<string, string | undefined>;
  body: AsyncIterable<Uint8Array>;
  /** Abandon the body (and its socket). Safe to call more than once. */
  destroy(): void;
}
export type Transport = (req: TransportRequest) => Promise<TransportResponse>;

// ------------------------------------------------------------ address policy

type Cidr4 = [number, number]; // [network as uint32, prefix length]

function v4(a: number, b: number, c: number, d: number): number {
  return ((a << 24) | (b << 16) | (c << 8) | d) >>> 0;
}

/** Every IPv4 range that is not ordinary public unicast (IANA special-purpose registry). */
const BLOCKED_V4: Cidr4[] = [
  [v4(0, 0, 0, 0), 8],        // "this network", incl. 0.0.0.0 (unspecified)
  [v4(10, 0, 0, 0), 8],       // private
  [v4(100, 64, 0, 0), 10],    // CGNAT shared address space
  [v4(127, 0, 0, 0), 8],      // loopback
  [v4(169, 254, 0, 0), 16],   // link-local, incl. cloud metadata 169.254.169.254
  [v4(172, 16, 0, 0), 12],    // private
  [v4(192, 0, 0, 0), 24],     // IETF protocol assignments
  [v4(192, 0, 2, 0), 24],     // TEST-NET-1
  [v4(192, 88, 99, 0), 24],   // 6to4 relay anycast (deprecated)
  [v4(192, 168, 0, 0), 16],   // private
  [v4(198, 18, 0, 0), 15],    // benchmarking
  [v4(198, 51, 100, 0), 24],  // TEST-NET-2
  [v4(203, 0, 113, 0), 24],   // TEST-NET-3
  [v4(224, 0, 0, 0), 4],      // multicast
  [v4(240, 0, 0, 0), 4],      // reserved, incl. 255.255.255.255 broadcast
];

/** Strict dotted-quad only; the URL parser has already normalised 0x7f.1 and friends. */
function parseV4(s: string): number | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(s);
  if (!m) return null;
  const o = m.slice(1).map(Number);
  if (o.some((n) => n > 255)) return null;
  return v4(o[0], o[1], o[2], o[3]);
}

function v4Public(n: number): boolean {
  return !BLOCKED_V4.some(([net, len]) => {
    const mask = len === 0 ? 0 : (0xffffffff << (32 - len)) >>> 0;
    return ((n & mask) >>> 0) === net;
  });
}

/** 16 bytes, or null. Handles '::' and a dotted-quad tail. A zone id (%eth0) is refused. */
function parseV6(s: string): Uint8Array | null {
  if (s.includes('%')) return null;
  let head = s;
  let tail4: number | null = null;
  const lastColon = s.lastIndexOf(':');
  if (s.slice(lastColon + 1).includes('.')) {
    tail4 = parseV4(s.slice(lastColon + 1));
    if (tail4 === null) return null;
    head = s.slice(0, lastColon + 1) + '0:0'; // placeholder groups, overwritten below
  }
  const parts = head.split('::');
  if (parts.length > 2) return null;
  const groups = (p: string) => (p === '' ? [] : p.split(':'));
  const left = groups(parts[0]);
  const right = parts.length === 2 ? groups(parts[1]) : [];
  const fill = 8 - left.length - right.length;
  if (parts.length === 1 ? left.length !== 8 : fill < 1) return null;
  const all = [...left, ...Array(parts.length === 2 ? fill : 0).fill('0'), ...right];
  const out = new Uint8Array(16);
  for (let i = 0; i < 8; i++) {
    if (!/^[0-9a-f]{1,4}$/i.test(all[i])) return null;
    const g = parseInt(all[i], 16);
    out[i * 2] = g >> 8;
    out[i * 2 + 1] = g & 0xff;
  }
  if (tail4 !== null) {
    out[12] = tail4 >>> 24; out[13] = (tail4 >>> 16) & 0xff;
    out[14] = (tail4 >>> 8) & 0xff; out[15] = tail4 & 0xff;
  }
  return out;
}

function prefixMatch(b: Uint8Array, prefix: number[], bits: number): boolean {
  for (let i = 0; i < bits; i++) {
    const byte = i >> 3;
    const mask = 0x80 >> (i & 7);
    if (((b[byte] ?? 0) & mask) !== ((prefix[byte] ?? 0) & mask)) return false;
  }
  return true;
}

function embeddedV4(b: Uint8Array): number {
  return v4(b[12], b[13], b[14], b[15]);
}

function v6Public(b: Uint8Array): boolean {
  // ::ffff:a.b.c.d -- IPv4-mapped: judged as the IPv4 address it carries.
  if (prefixMatch(b, [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0xff, 0xff], 96)) return v4Public(embeddedV4(b));
  // 64:ff9b::/96 -- NAT64 well-known prefix: also carries an IPv4 address.
  if (prefixMatch(b, [0, 0x64, 0xff, 0x9b, 0, 0, 0, 0, 0, 0, 0, 0], 96)) return v4Public(embeddedV4(b));
  // Only global unicast (2000::/3) is public. This one rule refuses ::, ::1,
  // IPv4-compatible ::a.b.c.d, ULA fc00::/7, link-local fe80::/10, site-local
  // fec0::/10, multicast ff00::/8, discard 100::/64 and 64:ff9b:1::/48.
  if (!prefixMatch(b, [0x20], 3)) return false;
  // ...minus the special-purpose blocks inside it.
  if (prefixMatch(b, [0x20, 0x01, 0x00, 0x00], 23)) return false; // IETF protocol assignments, incl. Teredo 2001::/32
  if (prefixMatch(b, [0x20, 0x01, 0x0d, 0xb8], 32)) return false; // documentation
  if (prefixMatch(b, [0x20, 0x02], 16)) return false;             // 6to4: can embed any IPv4, incl. private
  if (prefixMatch(b, [0x3f, 0xff], 20)) return false;             // documentation (RFC 9637)
  return true;
}

/**
 * True only for an address the server may connect to: ordinary public
 * unicast, IPv4 or IPv6. Anything unparseable is NOT public.
 */
export function isPublicAddress(ip: string): boolean {
  const bare = ip.startsWith('[') && ip.endsWith(']') ? ip.slice(1, -1) : ip;
  const kind = isIP(bare);
  if (kind === 4) {
    const n = parseV4(bare);
    return n !== null && v4Public(n);
  }
  if (kind === 6) {
    const b = parseV6(bare);
    return b !== null && v6Public(b);
  }
  return false;
}

// ------------------------------------------------------------- URL policy

export type VettedUrl = { ok: true; url: URL } | { ok: false; code: UrlFetchCode };

/** Everything that can be decided from the URL text alone. */
export function vetUrl(raw: string, maxUrlLength: number = URL_FETCH_LIMITS.maxUrlLength): VettedUrl {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > maxUrlLength) return { ok: false, code: 'invalid_url' };
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return { ok: false, code: 'invalid_url' };
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return { ok: false, code: 'unsupported_scheme' };
  if (url.username !== '' || url.password !== '') return { ok: false, code: 'credentials_not_allowed' };
  // URL drops a port equal to the scheme's default, so '' means 80 or 443.
  if (url.port !== '' && !ALLOWED_PORTS.has(Number(url.port))) return { ok: false, code: 'port_not_allowed' };
  if (url.hostname === '') return { ok: false, code: 'invalid_url' };
  url.hash = '';
  return { ok: true, url };
}

function bareHost(url: URL): string {
  const h = url.hostname;
  return h.startsWith('[') && h.endsWith(']') ? h.slice(1, -1) : h;
}

/** Decide where to connect for one hop, or why not. */
async function vetHost(url: URL, resolve: Resolver): Promise<{ ok: true; addr: ResolvedAddress } | { ok: false; code: UrlFetchCode }> {
  const host = bareHost(url);
  const literal = isIP(host);
  if (literal) {
    return isPublicAddress(host)
      ? { ok: true, addr: { address: host, family: literal as 4 | 6 } }
      : { ok: false, code: 'address_not_allowed' };
  }
  // Would resolve to loopback anyway; refused without asking DNS.
  const lower = host.toLowerCase().replace(/\.$/, '');
  if (lower === 'localhost' || lower.endsWith('.localhost')) return { ok: false, code: 'address_not_allowed' };

  let addrs: ResolvedAddress[];
  try {
    addrs = await resolve(host);
  } catch {
    return { ok: false, code: 'unreachable' };
  }
  if (addrs.length === 0) return { ok: false, code: 'unreachable' };
  // ALL of them, not just the one we would pick: a name with one public and
  // one private record is somebody arranging to reach the private one.
  if (!addrs.every((a) => isPublicAddress(a.address))) return { ok: false, code: 'address_not_allowed' };
  return { ok: true, addr: addrs[0] };
}

// ------------------------------------------------------------- the fetch

const REDIRECTS = new Set([301, 302, 303, 307, 308]);

export interface UrlFetchDeps {
  resolve: Resolver;
  transport: Transport;
}

export const defaultResolver: Resolver = async (hostname) => {
  const all = await dnsLookup(hostname, { all: true, verbatim: true });
  return all.map((a) => ({ address: a.address, family: a.family === 6 ? 6 : 4 }));
};

/**
 * node:http(s) with the socket's lookup pinned to the vetted address. The
 * Host header and TLS SNI/certificate check still use the real hostname, so
 * https verifies the certificate of the name the user gave -- only the IP the
 * socket connects to is fixed. Plain node:http also ignores HTTP(S)_PROXY, so
 * no environment proxy can redirect the connection.
 */
export const nodeTransport: Transport = (req) => new Promise((resolve, reject) => {
  const mod = req.url.protocol === 'https:' ? https : http;
  const host = bareHost(req.url);
  const pinned: LookupFunction = (_hostname, options, cb) => {
    if (options && (options as { all?: boolean }).all) {
      (cb as unknown as (e: null, a: { address: string; family: number }[]) => void)(null, [{ address: req.address, family: req.family }]);
    } else {
      cb(null, req.address, req.family);
    }
  };
  const r = mod.request({
    protocol: req.url.protocol,
    hostname: host,
    port: req.url.port || (req.url.protocol === 'https:' ? 443 : 80),
    path: `${req.url.pathname}${req.url.search}`,
    method: 'GET',
    headers: req.headers,
    agent: false,
    lookup: pinned,
    ...(isIP(host) ? {} : { servername: host }),
    signal: req.signal,
  });
  r.on('response', (res) => {
    const headers: Record<string, string | undefined> = {};
    for (const [k, v] of Object.entries(res.headers)) headers[k.toLowerCase()] = Array.isArray(v) ? v[0] : v;
    resolve({
      status: res.statusCode ?? 0,
      headers,
      body: res as AsyncIterable<Uint8Array>,
      destroy: () => { res.destroy(); r.destroy(); },
    });
  });
  r.on('error', reject);
  r.end();
});

const defaultDeps: UrlFetchDeps = { resolve: defaultResolver, transport: nodeTransport };

const REQUEST_HEADERS = {
  'user-agent': 'webadf-url-fetch/1 (+disk image upload)',
  accept: '*/*',
  // Raw bytes only: the size cap must count what we hold, and a server that
  // gzips the response would otherwise need decoding (and a bomb guard).
  'accept-encoding': 'identity',
};

/**
 * Fetch `raw` under every rule above. Never throws for anything the URL or
 * the upstream does; the result's `code` is what the client may be told.
 */
export async function fetchUrlSafely(
  raw: string,
  deps: UrlFetchDeps = defaultDeps,
  limits: UrlFetchLimits = { ...URL_FETCH_LIMITS },
): Promise<UrlFetchResult> {
  const first = vetUrl(raw, limits.maxUrlLength);
  if (!first.ok) return first;

  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, limits.timeoutMs);
  // A resolver or transport that ignores the signal must still lose the race.
  const deadline = new Promise<never>((_, reject) => {
    controller.signal.addEventListener('abort', () => reject(new Error('deadline')), { once: true });
  });
  deadline.catch(() => {});
  const race = <T>(p: Promise<T>) => Promise.race([p, deadline]);

  let current: TransportResponse | null = null;
  try {
    let url = first.url;
    for (let hop = 0; ; hop++) {
      const where = await race(vetHost(url, deps.resolve));
      if (!where.ok) return where;

      try {
        current = await race(deps.transport({
          url, address: where.addr.address, family: where.addr.family,
          headers: { ...REQUEST_HEADERS }, signal: controller.signal,
        }));
      } catch {
        if (timedOut) return { ok: false, code: 'timeout' };
        return { ok: false, code: 'unreachable' };
      }

      if (REDIRECTS.has(current.status)) {
        const location = current.headers.location;
        current.destroy();
        current = null;
        if (!location) return { ok: false, code: 'upstream_status', status: 502 };
        if (hop >= limits.maxRedirects) return { ok: false, code: 'too_many_redirects' };
        let next: URL;
        try {
          next = new URL(location, url);
        } catch {
          return { ok: false, code: 'invalid_url' };
        }
        const vetted = vetUrl(next.toString(), limits.maxUrlLength);
        if (!vetted.ok) return vetted;
        url = vetted.url;
        continue;
      }

      if (current.status !== 200) {
        const status = current.status;
        current.destroy();
        current = null;
        return { ok: false, code: 'upstream_status', status };
      }

      // A claim, but a cheap early refusal when it is honest about being too big.
      const claimed = Number(current.headers['content-length']);
      if (Number.isFinite(claimed) && claimed > limits.maxBytes) {
        current.destroy();
        current = null;
        return { ok: false, code: 'too_large' };
      }

      // The enforcement that counts: bytes actually received.
      const chunks: Uint8Array[] = [];
      let total = 0;
      const iterator = current.body[Symbol.asyncIterator]();
      for (;;) {
        const step = await race(iterator.next());
        if (step.done) break;
        const chunk = step.value;
        total += chunk.byteLength;
        if (total > limits.maxBytes) {
          current.destroy();
          current = null;
          return { ok: false, code: 'too_large' };
        }
        chunks.push(chunk);
      }
      const bytes = new Uint8Array(total);
      let at = 0;
      for (const c of chunks) { bytes.set(c, at); at += c.byteLength; }
      const contentDisposition = current.headers['content-disposition'] ?? null;
      current = null;
      return { ok: true, bytes, finalUrl: url, contentDisposition };
    }
  } catch {
    if (timedOut) return { ok: false, code: 'timeout' };
    return { ok: false, code: 'unreachable' };
  } finally {
    clearTimeout(timer);
    current?.destroy();
    if (!controller.signal.aborted) controller.abort();
  }
}
