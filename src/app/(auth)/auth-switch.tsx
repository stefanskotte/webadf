import { Link } from '@/components/shell/link';

/**
 * Sign in / Create account (C5 spec §6.2, Ruling 31): two routes, so a nav of two links with aria-current, drawn as
 * the board's segmented tabs (.seg's surface look follows aria-current="page").
 */
export function AuthSwitch({ current }: { current: 'in' | 'up' }) {
  const item = 'seg-item h-9 px-[18px] text-[14px] font-semibold focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--ring)';
  return (
    <nav aria-label="Account" data-testid="auth-switch" className="seg self-start rounded-[12px] p-1">
      <Link href="/sign-in" aria-current={current === 'in' ? 'page' : undefined} className={item} style={{ color: 'var(--ink)' }}>
        Sign in
      </Link>
      <Link href="/sign-up" aria-current={current === 'up' ? 'page' : undefined} className={item} style={{ color: 'var(--ink)' }}>
        Create account
      </Link>
    </nav>
  );
}
