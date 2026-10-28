import { AuthSwitch } from '../auth-switch';
import { SignInForm } from './sign-in-form';
import { safeReturnPath } from '@/lib/sign-in-return';

// A server page so it can carry its own title (Ruling 36); the form is the client part.
export const metadata = { title: 'Sign in' };

export default async function SignInPage(props: PageProps<'/sign-in'>) {
  const sp = await props.searchParams;
  // ?expired=1&next=… comes from a page whose session was too old for it (src/lib/sign-in-return.ts).
  return (
    <>
      <AuthSwitch current="in" />
      <SignInForm expired={sp.expired === '1'} next={safeReturnPath(sp.next)} />
    </>
  );
}
