/** The User-Agent webadf sends to the public services it fetches from (GitHub, Demozoo, OpenRetro, tosecdev.org). */
export function webadfUserAgent(): string {
  const fallback = 'https://webadf.vercel.app';
  let origin = fallback;
  const v = process.env.BETTER_AUTH_URL;
  if (v) { try { origin = new URL(v).origin; } catch { /* keep the fallback */ } }
  if (origin === 'null') origin = fallback;
  return `webadf/1.0 (Amiga disk library; +${origin})`;
}
