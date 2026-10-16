/** The User-Agent webadf sends to the public services it fetches from (GitHub, Demozoo, OpenRetro, tosecdev.org). */
export function webadfUserAgent(): string {
  return `webadf/1.0 (Amiga disk library; +${process.env.BETTER_AUTH_URL || 'https://webadf.vercel.app'})`;
}
