import { AuthSwitch } from '../auth-switch';
import { SignInForm } from './sign-in-form';

// A server page so it can carry its own title (Ruling 36); the form is the client part.
export const metadata = { title: 'Sign in' };

export default function SignInPage() {
  return (
    <>
      <AuthSwitch current="in" />
      <SignInForm />
    </>
  );
}
