// Parsing a share link the recipient pasted (spec §4.2, Review Focus 4). CLIENT-SAFE: no node: imports, no @/db.
//
// The owner hands out `<origin>/s/<code>` (plus `#pin=<base64url sha256>` when their instance runs on a private CA,
// spec §3.3). People paste it with whitespace around it, with a trailing slash, or arrive with it wrapped in the
// recipient's own `/remote/add#link=<encoded link>` address; all of those parse to the same thing. Anything else is
// null -- the caller shows one "not a share link" message and never contacts anyone.

export type ParsedLink = { origin: string; code: string; pin: string | null };

/** A claim code: `wfsc_` + 32 random bytes as unpadded base64url (src/lib/share/tokens.ts). */
export const SHARE_CODE_RE = /^wfsc_[A-Za-z0-9_-]{43}$/;
/** A root pin: SHA-256 of the root certificate's DER, unpadded base64url. */
export const SHARE_PIN_RE = /^[A-Za-z0-9_-]{43}$/;

/** Longer than any honest link (origin + code + pin, wrapped and percent-encoded once). */
const MAX_LINK_LENGTH = 2048;

/** The environment switches read here; process.env fits. Looser than NodeJS.ProcessEnv so tests need no NODE_ENV. */
export type ShareEnv = { readonly [name: string]: string | undefined };

/** `WEBADF_SHARE_TEST_INSECURE=1` (set only by the e2e web server) also allows http: origins. */
export function shareInsecureAllowed(env: ShareEnv): boolean {
  return env.WEBADF_SHARE_TEST_INSECURE === '1';
}

function parse(raw: string, env: ShareEnv, unwrap: boolean): ParsedLink | null {
  const text = raw.trim();
  if (text === '' || text.length > MAX_LINK_LENGTH) return null;
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return null;
  }
  const httpOk = shareInsecureAllowed(env);
  if (url.protocol !== 'https:' && !(httpOk && url.protocol === 'http:')) return null;
  if (url.username !== '' || url.password !== '' || url.hostname === '') return null;

  const path = url.pathname.replace(/\/+$/, '');

  // The recipient's own Add page, carrying the link in its fragment. Unwrapped once only.
  if (path === '/remote/add') {
    if (!unwrap || !url.hash.startsWith('#link=')) return null;
    let inner: string;
    try {
      inner = decodeURIComponent(url.hash.slice('#link='.length));
    } catch {
      return null;
    }
    return parse(inner, env, false);
  }

  const m = /^\/s\/([^/]+)$/.exec(path);
  if (!m || !SHARE_CODE_RE.test(m[1])) return null;

  let pin: string | null = null;
  if (url.hash.length > 1) {
    const params = new URLSearchParams(url.hash.slice(1));
    const p = params.get('pin');
    if (p !== null) {
      // A malformed pin is refused, never dropped: dropping it would quietly ask for ordinary verification.
      if (!SHARE_PIN_RE.test(p)) return null;
      pin = p;
    }
  }
  return { origin: url.origin, code: m[1], pin };
}

/** Origin, code and pin of a pasted share link, or null when it is not one. */
export function parseShareLink(raw: string, env: ShareEnv = process.env): ParsedLink | null {
  if (typeof raw !== 'string') return null;
  return parse(raw, env, true);
}
