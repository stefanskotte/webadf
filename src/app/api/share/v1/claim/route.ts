import { limitClaim, shareJson, withShare } from '@/lib/share/api';
import { libraryName } from '@/lib/share/listing';
import { claimShare } from '@/lib/share/store';
import { SHARE_PROTOCOL } from '@/lib/share/types';
import type { ShareClaimResponse } from '@/lib/share/types';

export const dynamic = 'force-dynamic';

/** One answer for an unknown, expired, used or revoked code, and for a malformed request: codes cannot be probed. */
const invalid = () => shareJson({ error: 'invalid_or_used' }, 404);

/**
 * Exchange a one-time claim code for the share's bearer token (spec §3.2). Rate-limited per client IP, counted on
 * attempts. The protocol is checked BEFORE claimShare, so a recipient that needs an update keeps its code.
 */
export const POST = withShare(async (req: Request) => {
  const limited = limitClaim(req);
  if (limited) return limited;

  let body: unknown;
  try { body = await req.json(); } catch { return invalid(); }
  if (!body || typeof body !== 'object') return invalid();
  const { code, protocol, instanceUrl, instanceName } = body as Record<string, unknown>;
  if (protocol !== SHARE_PROTOCOL) return shareJson({ error: 'protocol', supported: [SHARE_PROTOCOL] }, 409);
  if (typeof code !== 'string' || typeof instanceUrl !== 'string' || typeof instanceName !== 'string') return invalid();

  const claimed = await claimShare(code, { url: instanceUrl, name: instanceName });
  if (!claimed.ok) return invalid();
  const res: ShareClaimResponse = {
    token: claimed.token, protocol: SHARE_PROTOCOL, library: { name: await libraryName(claimed.orgId) },
  };
  return shareJson(res);
});
