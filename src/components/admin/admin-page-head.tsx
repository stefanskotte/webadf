import { PageHeader } from '@/components/shell/page-header';
import { AdminSections } from '@/components/admin/admin-nav';

/** Every admin page's body: the page gutter, a column, 24 px between blocks (C6 spec §1.3). */
export const ADMIN_BODY = 'flex flex-col gap-6 px-4 pb-10 sm:px-7';

/** Every admin page opens with this (C6 spec §1.3, Ruling 6): the lg heading under `Admin · this server`, then the tabs. */
export function AdminPageHead({ title, subtitle, subtitleFont, actions }: {
  title: string; subtitle?: string; subtitleFont?: 'mono' | 'sans'; actions?: React.ReactNode;
}) {
  return (
    <>
      <PageHeader size="lg" eyebrow="Admin · this server" title={title} subtitle={subtitle}
                  subtitleFont={subtitleFont} actions={actions} />
      {/* A column with items-start: the clamp's max-w-full then caps it at the gutter and it scrolls inside. */}
      <div className="flex flex-col items-start px-4 pb-6 sm:px-7">
        <AdminSections />
      </div>
    </>
  );
}
