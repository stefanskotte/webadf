import { AdminLoadingFrame } from '@/components/admin/admin-loading-frame';

// Overview's subtitle is a 14 px sans sentence that wraps to two lines below lg (one line at 21 px from lg up), so
// its frame reserves that height; the other admin pages keep the one-line mono bone (C6 Task 7, carried from the
// Task 1 review). The route group (overview) gives this page its own loading boundary without changing the URL.
export default function AdminOverviewLoading() {
  return <AdminLoadingFrame subtitleHeight="h-[42px] lg:h-[21px]" />;
}
