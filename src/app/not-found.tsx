import { StateCard, StateLink } from '@/components/shell/state-card';

// An address that matches no route at all (A1 States). Outside every shell, so it works signed out too.
export default function NotFound() {
  return (
    <StateCard
      testId="page-not-found"
      title="Page not found"
      message="There is no page at this address. The link may be mistyped or out of date."
    >
      <StateLink href="/">Go to the start page</StateLink>
    </StateCard>
  );
}
