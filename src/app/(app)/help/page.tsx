import { HelpBrowser } from '@/components/help/help-browser';

export const metadata = { title: 'Help' };

// Every help topic on one page (spec 2026-10-05-context-help; layout C5 §3, board InfHelp). The "?" popovers
// and the header search link here as /help#<id>; scroll-mt-6 keeps an article's heading clear of the top when it
// is the target (the header is not sticky).
export default function HelpPage() {
  return <HelpBrowser />;
}
