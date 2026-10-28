// This instance as an owner (spec §3.3): its public address, the links it hands out, and whether other servers can
// reach it. SERVER ONLY.
//
// The pin: a self-hosted instance on Caddy's internal CA (`tls internal`) has a root no other server trusts, so its
// links carry that root's fingerprint. The app container cannot read Caddy's pki files (Ruling C1), so the pin is
// fetched the way a recipient would: <origin>/.well-known/webadf-root.pem, served by Caddy (Task 10). Where that
// answers 404 (a publicly trusted certificate, a hosted deployment) links carry no pin.

import { fetchLocalRootPin, shareClient, type ShareResult, type ShareTarget } from './client';
import type { ShareEnv } from './link';
import { SHARE_PROTOCOL } from './types';

export type InstanceDeps = {
  env?: ShareEnv;
  now?: () => number;
  /** The root pin at an origin: null = none served (404); throws = could not tell. */
  fetchPin?: (origin: string) => Promise<string | null>;
  ping?: (t: ShareTarget) => Promise<ShareResult<{ protocol: number }>>;
};

const PIN_CACHE_MS = 60 * 60 * 1000;
let pinCache: { origin: string; pin: string | null; expires: number } | null = null;

/** Tests only. */
export function clearInstanceCacheForTests(): void {
  pinCache = null;
}

/** The origin this instance is reached at: BETTER_AUTH_URL (self-host sets it from WEBADF_URL / WEBADF_DOMAIN). */
export function publicOrigin(env: ShareEnv = process.env): string {
  const raw = env.BETTER_AUTH_URL;
  if (!raw) throw new Error('BETTER_AUTH_URL is not set: this server does not know its own address');
  return new URL(raw).origin;
}

/** The link the owner hands out. The pin rides in the fragment, which browsers never send to a server. */
export function shareLink(code: string, pin: string | null, env: ShareEnv = process.env): string {
  return `${publicOrigin(env)}/s/${code}${pin ? `#pin=${pin}` : ''}`;
}

/**
 * The local root's pin and, when it could not be read, why. A result (pin or a 404's null) is cached an hour per
 * origin; a failure is not, so the next share or reachability check tries again.
 */
export async function localRootPinState(deps: InstanceDeps = {}): Promise<{ pin: string | null; error: string | null }> {
  const env = deps.env ?? process.env;
  const now = (deps.now ?? Date.now)();
  const origin = publicOrigin(env);
  if (pinCache && pinCache.origin === origin && pinCache.expires > now) return { pin: pinCache.pin, error: null };
  const fetchPin = deps.fetchPin ?? ((o: string) => fetchLocalRootPin(o, { env }));
  try {
    const pin = await fetchPin(origin);
    pinCache = { origin, pin, expires: now + PIN_CACHE_MS };
    return { pin, error: null };
  } catch (e) {
    return { pin: null, error: e instanceof Error ? e.message : String(e) };
  }
}

export async function localRootPin(deps: InstanceDeps = {}): Promise<string | null> {
  return (await localRootPinState(deps)).pin;
}

function describeFailure(r: Extract<ShareResult<unknown>, { ok: false }>): string {
  const d = r.detail ? ` (${r.detail})` : '';
  switch (r.failure) {
    case 'unreachable': return `no answer${d}`;
    case 'protocol': return 'it answered with a different WebFloppy version';
    case 'bad_response': return `it answered, but not as a WebFloppy${d}`;
    default: return `unexpected answer: ${r.failure}${d}`;
  }
}

/**
 * GET <public origin>/api/share/v1/ping from this server, through the same guarded client a recipient uses, with
 * this instance's own pin. Proves the address resolves and answers from where the server stands -- not from the
 * internet (the help topic says so).
 */
export async function checkReachability(deps: InstanceDeps = {}): Promise<{ ok: boolean; origin: string; detail?: string }> {
  const env = deps.env ?? process.env;
  const origin = publicOrigin(env);
  const { pin, error } = await localRootPinState(deps);
  const ping = deps.ping ?? ((t: ShareTarget) => shareClient({ env }).ping(t));
  const pinNote = error ? `; certificate root: ${error}` : '';
  let r: ShareResult<{ protocol: number }>;
  try {
    r = await ping({ origin, pin });
  } catch (e) {
    return { ok: false, origin, detail: `no answer (${e instanceof Error ? e.message : 'error'})${pinNote}` };
  }
  if (!r.ok) return { ok: false, origin, detail: describeFailure(r) + pinNote };
  if (r.value.protocol !== SHARE_PROTOCOL) {
    return { ok: false, origin, detail: 'it answered with a different WebFloppy version' + pinNote };
  }
  return { ok: true, origin };
}
