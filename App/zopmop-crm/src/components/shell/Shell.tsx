import { Suspense, useState } from 'react';
import { Outlet, useLocation } from 'react-router-dom';
import { Sidebar } from './Sidebar';
import { Topbar } from './Topbar';
import { PageSkeleton } from '@/components/common/PageSkeleton';
import { ErrorBoundary } from '@/components/common/ErrorBoundary';

export function Shell() {
  const [collapsed, setCollapsed] = useState(false);
  const location = useLocation();
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
          {/* keyed on pathname so a route's error clears on navigation */}
          <ErrorBoundary key={location.pathname}>
            <Suspense fallback={<PageSkeleton />}>
              <Outlet />
            </Suspense>
          </ErrorBoundary>
        </main>
      </div>
    </div>
  );
}
