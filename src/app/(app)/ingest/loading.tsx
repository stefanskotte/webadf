import { Bone, PageSkeleton } from '@/components/shell/skeleton';

// The Upload page while it loads (C3 spec 6.4): heading and subtitle bones, the two drop cards, then the Staging
// section with four row bones. Nested under (app)/loading.tsx like the library's and the devices', so status codes
// do not change.
export default function UploadLoading() {
  return (
    <PageSkeleton testId="upload-skeleton">
      <div className="flex flex-col gap-2 px-4 pb-4 sm:px-7">
        <Bone className="h-11 w-40" />
        <Bone className="h-3 w-72" />
      </div>
      <div className="flex flex-col gap-6 px-4 pb-10 sm:px-7">
        <div className="grid gap-5 lg:grid-cols-2">
          {[0, 1].map((i) => (
            <div key={i} data-skeleton-card className="flex h-[134px] items-center gap-5 rounded-[20px] p-6"
                 style={{ border: '1.5px dashed var(--line-strong)' }}>
              <Bone className="h-[84px] w-[84px] shrink-0" />
              <div className="flex flex-1 flex-col gap-2"><Bone className="h-5 w-2/3" /><Bone className="h-3 w-full" /><Bone className="h-[38px] w-28" /></div>
            </div>
          ))}
        </div>
        <div className="flex flex-col gap-3 rounded-[20px] p-5" style={{ background: 'var(--surface)', boxShadow: '0 0 0 1px var(--line)' }}>
          <Bone className="h-[34px] w-full" />
          {[0, 1, 2, 3].map((i) => <div key={i} data-skeleton-row><Bone className="h-[58px] w-full" /></div>)}
        </div>
      </div>
    </PageSkeleton>
  );
}
