import { PageHeader } from '@/components/shell/page-header';
import { HELP_TOPICS, HELP_ORDER } from '@/lib/help/topics';

export const metadata = { title: 'Help' };

// One section per help topic (spec 2026-10-05-context-help). The "?" popovers
// link here as /help#<id>; scroll-mt keeps a section's title clear of the
// sticky header when it is the target.
export default function HelpPage() {
  return (
    <>
      <PageHeader title="Help"
                  subtitle="What the less obvious parts of webadf do, and why." />
      <div className="flex flex-col gap-3 px-4 pb-10 sm:px-7">
        <nav aria-label="Topics" className="glass-card p-4 text-[13.5px]">
          <ul className="flex flex-wrap gap-x-4 gap-y-1">
            {HELP_ORDER.map((id) => (
              <li key={id}>
                <a href={`#${id}`} className="font-semibold underline-offset-2 hover:underline">{HELP_TOPICS[id].title}</a>
              </li>
            ))}
          </ul>
        </nav>
        {HELP_ORDER.map((id) => (
          <section key={id} id={id} data-testid={`help-section-${id}`}
                   className="glass-card scroll-mt-24 space-y-3 p-5 text-[14.5px] leading-relaxed">
            <h2 className="text-[18px] font-bold">{HELP_TOPICS[id].title}</h2>
            <div className="max-w-[68ch] space-y-3">{HELP_TOPICS[id].body}</div>
          </section>
        ))}
      </div>
    </>
  );
}
