import { Bone } from '@/components/shell/skeleton';

// Settings › Server while it loads (tabs 2026-10-28): one card under the layout's heading and tabs.
export default function ServerSettingsLoading() {
  const card = { background: 'var(--surface)', boxShadow: '0 0 0 1px var(--line)' };
  return (
    <div role="status" aria-busy="true" data-testid="settings-skeleton">
      <span className="sr-only">Loading…</span>
      <div className="flex max-w-[916px] flex-col gap-5 px-4 pb-10 pt-6 sm:px-7">
        <div data-skeleton-card className="flex flex-col gap-3 rounded-[20px] p-5 sm:p-6" style={card}>
          <Bone className="h-[17px] w-32" />
          <Bone className="h-3 w-2/3" />
          <Bone className="h-24 w-full" />
        </div>
      </div>
    </div>
  );
}
