import { StateCard, StateLink } from '@/components/shell/state-card';

// notFound() from a page under the app shell -- a title or disk id that is not this org's (A1 States). The same words
// for "deleted" and "someone else's": a page that told them apart would tell another tenant which ids exist.
export default function AppNotFound() {
  return (
    <StateCard
      testId="not-found-page"
      title="That isn't in your library"
      message="It may have been deleted, or the link belongs to another account."
    >
      <StateLink href="/library">Back to the library</StateLink>
    </StateCard>
  );
}
