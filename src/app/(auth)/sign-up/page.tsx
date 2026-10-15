import { SignUpForm } from './sign-up-form';

/**
 * The invite code is read here, on the server, and handed to the form. A client page reading useSearchParams
 * under a Suspense with no fallback prerendered to an empty shell in a production build: no form until the
 * JavaScript ran, and nothing at all without it.
 */
export default async function SignUpPage(props: PageProps<'/sign-up'>) {
  const invite = (await props.searchParams).invite;
  return <SignUpForm initialInviteCode={(Array.isArray(invite) ? invite[0] : invite) ?? ''} />;
}
