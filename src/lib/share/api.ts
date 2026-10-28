// Shared plumbing for the share API routes (src/app/api/share/v1/): the protocol header on every answer, bearer
// auth, and the per-token / per-IP rate limits. Server only (reaches @/db through store.ts).
import { SlidingWindowLimiter } from '@/lib/url-fetch-limit';
import { authenticateShare, type ShareAuth } from './store';
import { SHARE_PROTOCOL } from './tokens';
import { SHARE_PROTOCOL_HEADER } from './types';

const MINUTE = 60_000;
export const SHARE_RATE = {
  listPerMinute: 120,
  bytesPerMinute: 30,
  claimPerMinutePerIp: 10,
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

/**
 * Authenticate the bearer token (unknown and revoked alike answer 401) and take one request from the token's
 * `list` or `bytes` budget. Returns the auth, or the Response to send instead.
 */
export async function authorizeShare(req: Request, budget: 'list' | 'bytes'): Promise<ShareAuth | Response> {
  const auth = await authenticateShare(req.headers.get('authorization'));
  if (!auth) return unauthorized();
  const limit = budget === 'bytes' ? SHARE_RATE.bytesPerMinute : SHARE_RATE.listPerMinute;
  const r = limiter.take([{ key: `share:${auth.shareId}:${budget}`, limit, windowMs: MINUTE }]);
  return r.ok ? auth : tooMany(r.retryAfterMs);
}
