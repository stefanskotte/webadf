/**
 * Hosted or self-hosted (About page spec D2). Self-hosted is the default:
 * only our deployment sets SELFHOSTED=false (Vercel project env), so a
 * self-hoster sets nothing. Exact, lowercase match -- anything else,
 * including "False", reads self-hosted. The only reader of SELFHOSTED.
 */
export type HostingMode = 'hosted' | 'self-hosted';

export const HOSTED_LABEL = 'Hosted (webadf.vercel.app)';
export const SELF_HOSTED_LABEL = 'Self-hosted';

export function hostingMode(raw: string | undefined = process.env.SELFHOSTED): HostingMode {
  return raw === 'false' ? 'hosted' : 'self-hosted';
}
