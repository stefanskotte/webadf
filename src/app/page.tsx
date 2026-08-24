import { redirect } from 'next/navigation';

/**
 * The app has no marketing page — "/" is just the way in. This used to be the
 * untouched create-next-app scaffold ("edit this page", Next.js/Vercel
 * links), which was the landing page on the live deployment.
 *
 * /library is behind requireOrg(), which bounces an unauthenticated visitor to
 * /sign-in, so this single redirect serves both signed-in and signed-out
 * visitors correctly.
 */
export default function Home() {
  redirect('/library');
}
