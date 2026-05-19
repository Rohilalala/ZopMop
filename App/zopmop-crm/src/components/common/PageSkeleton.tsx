import { Skeleton } from '@/components/ui';

// PageSkeleton — Suspense fallback for lazy-loaded routes. Lives inside the
// Shell, so the sidebar + topbar stay rendered while the chunk is fetched.
// Layout-matched to a typical page (title row + filter row + content rows)
// so the swap to the real page is visually quiet.
export function PageSkeleton() {
  return (
    <div className="p-6 space-y-6">
      <div className="space-y-2">
        <Skeleton className="h-7 w-48" />
        <Skeleton className="h-4 w-72" />
      </div>
      <Skeleton className="h-14 w-full" />
      <div className="space-y-2">
        <Skeleton className="h-10 w-full" />
        <Skeleton className="h-10 w-full" />
        <Skeleton className="h-10 w-full" />
        <Skeleton className="h-10 w-full" />
        <Skeleton className="h-10 w-full" />
      </div>
    </div>
  );
}
