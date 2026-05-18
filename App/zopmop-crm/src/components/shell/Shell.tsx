import { Suspense, useState } from 'react';
import { Outlet } from 'react-router-dom';
import { Sidebar } from './Sidebar';
import { Topbar } from './Topbar';
import { PageSkeleton } from '@/components/common/PageSkeleton';

export function Shell() {
  const [collapsed, setCollapsed] = useState(false);
  return (
    <div className="flex h-screen overflow-hidden">
      <Sidebar collapsed={collapsed} onToggleCollapsed={() => setCollapsed((v) => !v)} />
      <div className="flex-1 flex flex-col min-w-0">
        <Topbar />
        <main className="flex-1 overflow-y-auto">
          {/*
            Suspense wraps the route Outlet so route-level React.lazy fetches
            render PageSkeleton in the content area while Sidebar + Topbar
            stay mounted. App.tsx-level Suspense would unmount the whole
            shell during chunk loads.
          */}
          <Suspense fallback={<PageSkeleton />}>
            <Outlet />
          </Suspense>
        </main>
      </div>
    </div>
  );
}
