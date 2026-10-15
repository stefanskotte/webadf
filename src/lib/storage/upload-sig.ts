import { createHmac, hkdfSync, timingSafeEqual } from 'node:crypto';

function signingKey(): Buffer {
  const secret = process.env.BETTER_AUTH_SECRET;
  if (!secret) throw new Error('BETTER_AUTH_SECRET is not set');
  return Buffer.from(hkdfSync('sha256', secret, Buffer.alloc(0), 'webadf-blob-upload', 32));
}
const mac = (key: string, exp: number, max: number) =>
  createHmac('sha256', signingKey()).update(`${key}\n${exp}\n${max}`).digest('base64url');

/** P1 D9: an upload URL on the app itself, for the local backend. */
export async function signUpload(key: string, maxBytes: number, ttlMs: number, now = Date.now()) {
  const exp = Math.floor((now + ttlMs) / 1000);
  const base = process.env.BETTER_AUTH_URL;
  if (!base) throw new Error('BETTER_AUTH_URL is not set');
  const u = new URL(`/api/blob-upload/${key}`, base);
  u.searchParams.set('exp', String(exp));
  u.searchParams.set('max', String(maxBytes));
  u.searchParams.set('sig', mac(key, exp, maxBytes));
  return { url: u.toString(), expiresAt: new Date(exp * 1000) };
}

export function verifyUpload(key: string, q: URLSearchParams, now = Date.now()):
  { ok: true; max: number } | { ok: false; status: 403 } {
  const exp = Number(q.get('exp')); const max = Number(q.get('max')); const sig = q.get('sig') ?? '';
  if (!Number.isInteger(exp) || !Number.isInteger(max) || max <= 0 || exp * 1000 < now) return { ok: false, status: 403 };
  const want = Buffer.from(mac(key, exp, max)); const got = Buffer.from(sig);
  if (want.length !== got.length || !timingSafeEqual(want, got)) return { ok: false, status: 403 };
  return { ok: true, max };
}
