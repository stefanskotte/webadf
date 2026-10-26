import { AdminLoadingFrame } from '@/components/admin/admin-loading-frame';

// Any admin page while it loads (C6 spec §1.7, Ruling 37); the frame lives in components/admin.
export default function AdminLoading() {
  return <AdminLoadingFrame />;
}
