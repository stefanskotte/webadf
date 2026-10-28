// Shared plumbing for the share API routes (src/app/api/share/v1/): the protocol header on every answer, bearer
// auth, and the per-token / per-IP rate limits. Server only (reaches @/db through store.ts).
import { SlidingWindowLimiter } from '@/lib/url-fetch-limit';
import { authenticateShare, type ShareAuth } from './store';
import { SHARE_PROTOCOL, SHARE_PROTOCOL_HEADER } from './types';

const MINUTE = 60_000;
export const SHARE_RATE = {
  listPerMinute: 120,
  bytesPerMinute: 30,
  /** Its own bucket: a grid of covers must not eat the listing budget (fix round 1 ruling). */
  coversPerMinute: 600,
  claimPerMinutePerIp: 10,
  authFailuresPerMinutePerIp: 60,
} as const;

// In memory, per function instance -- the same trade-off url-fetch-limit.ts records for upload from a URL.
const limiter = new SlidingWindowLimiter();

function shareHeaders(extra?: HeadersInit): Headers {
  const h = new Headers(extra);
  h.set(SHARE_PROTOCOL_HEADER, String(SHARE_PROTOCOL));
  h.set('Cache-Control', 'no-store');
  return h;
}

/** Every JSON answer of the share API, errors included. */
export function shareJson(body: unknown, status = 200, extra?: HeadersInit): Response {
  return Response.json(body, { status, headers: shareHeaders(extra) });
}

/** A non-JSON answer (disk bytes, a cover) with the same protocol and cache headers. */
export function shareBody(body: Uint8Array, headers: HeadersInit): Response {
  return new Response(body as unknown as BodyInit, { status: 200, headers: shareHeaders(headers) });
}

export const notFound = () => shareJson({ error: 'not_found' }, 404);
export const unauthorized = () => shareJson({ error: 'unauthorized' }, 401);

function tooMany(retryAfterMs: number): Response {
  return shareJson({ error: 'rate_limited' }, 429, { 'Retry-After': String(Math.max(1, Math.ceil(retryAfterMs / 1000))) });
}

/** First x-forwarded-for entry, else x-real-ip, else 'unknown'. */
export function clientIp(req: Request): string {
  const fwd = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim();
  return fwd || req.headers.get('x-real-ip')?.trim() || 'unknown';
}

/** Null = within the claim budget for this client IP; otherwise the 429 to send. */
export function limitClaim(req: Request): Response | null {
  const r = limiter.take([{ key: `share-claim:${clientIp(req)}`, limit: SHARE_RATE.claimPerMinutePerIp, windowMs: MINUTE }]);
  return r.ok ? null : tooMany(r.retryAfterMs);
}

const BUDGET = {
  list: SHARE_RATE.listPerMinute,
  bytes: SHARE_RATE.bytesPerMinute,
  covers: SHARE_RATE.coversPerMinute,
} as const;

/**
 * Authenticate the bearer token (unknown and revoked alike answer 401) and take one request from the token's
 * budget. A failed authentication counts against the client IP (`share-auth-fail:<ip>`); past that budget the
 * answer is 429 instead of 401. A successful one never touches the IP budget. Returns the auth, or the Response.
 */
export async function authorizeShare(req: Request, budget: keyof typeof BUDGET): Promise<ShareAuth | Response> {
  const auth = await authenticateShare(req.headers.get('authorization'));
  if (!auth) {
    const f = limiter.take([{
      key: `share-auth-fail:${clientIp(req)}`, limit: SHARE_RATE.authFailuresPerMinutePerIp, windowMs: MINUTE,
    }]);
    return f.ok ? unauthorized() : tooMany(f.retryAfterMs);
  }
  const r = limiter.take([{ key: `share:${auth.shareId}:${budget}`, limit: BUDGET[budget], windowMs: MINUTE }]);
  return r.ok ? auth : tooMany(r.retryAfterMs);
}

/**
 * Every share route handler goes through this: an uncaught exception is logged and still answers with the
 * protocol header (503 unavailable), never the framework's bare 500.
 */
export function withShare<A extends unknown[]>(handler: (...args: A) => Promise<Response>): (...args: A) => Promise<Response> {
  return async (...args: A) => {
    try {
      return await handler(...args);
    } catch (err) {
      console.error('[share] handler failed', err);
      return shareJson({ error: 'unavailable' }, 503);
    }
  };
}
