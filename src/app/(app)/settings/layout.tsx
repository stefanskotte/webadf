import { SettingsHead } from '@/components/prefs/settings-sections';

// Settings' heading and tabs (Account | Library | Server; reorganisation 2026-10-28) stay put while a tab loads: each
// tab's loading.tsx replaces only the body under them.
export default function SettingsLayout({ children }: LayoutProps<'/settings'>) {
  return (
    <>
      <SettingsHead />
      {children}
    </>
  );
}
