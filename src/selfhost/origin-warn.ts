/** Self-hosting P2 (spec D8): one warning per host that does not match WEBADF_URL. */
export function originWarner(expected: string | undefined, log: (l: string) => void = (l) => console.warn(l)) {
  const seen = new Set<string>();
  return (req: Request) => {
    if (!expected) return;
    const host = req.headers.get('x-forwarded-host') ?? req.headers.get('host');
    if (!host) return;
    const proto = req.headers.get('x-forwarded-proto') ?? new URL(req.url).protocol.replace(':', '');
    const origin = `${proto}://${host}`;
    if (origin === expected || seen.has(origin)) return;
    seen.add(origin);
    log(`requests arrive as ${origin} but WEBADF_URL is ${expected} -- uploads and sign-in will fail; set WEBADF_URL to the address you open`);
  };
}

export const warnOnOrigin = originWarner(process.env.WEBADF_URL ? process.env.BETTER_AUTH_URL : undefined);
