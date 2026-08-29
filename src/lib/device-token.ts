import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';

const PREFIX = 'wadf_';

export function hashDeviceToken(plaintext: string): string {
  return createHash('sha256').update(plaintext).digest('hex');
}

export function mintDeviceToken(): { plaintext: string; hash: string } {
  const plaintext = PREFIX + randomBytes(32).toString('base64url');
  return { plaintext, hash: hashDeviceToken(plaintext) };
}

/** Constant-time comparison of two hex digests. Never throws. */
export function tokensMatch(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}
