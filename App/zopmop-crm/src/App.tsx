import { useEffect } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';

import { bootstrapAuth } from '@/api/client';
import { useAuth } from '@/store/auth';

import { LoginPage } from '@/pages/auth/LoginPage';
import { Shell } from '@/components/shell/Shell';
import { DashboardPage } from '@/pages/DashboardPage';
import { FlagsPage } from '@/pages/FlagsPage';
import { SessionsPage } from '@/pages/SessionsPage';
import { UsersPage } from '@/pages/users/UsersPage';
import { WorkersPage } from '@/pages/workers/WorkersPage';
import { LeavesPage } from '@/pages/LeavesPage';
import { LiveMapPage } from '@/pages/LiveMapPage';
import { OrdersPage } from '@/pages/OrdersPage';
import { RefundsPage } from '@/pages/RefundsPage';
import { PromosPage } from '@/pages/PromosPage';
import { BannersPage } from '@/pages/BannersPage';
import { ExperimentsPage } from '@/pages/ExperimentsPage';
import { AnalyticsPage } from '@/pages/AnalyticsPage';
import { PushPage } from '@/pages/PushPage';
import { PayoutsPage } from '@/pages/PayoutsPage';
import { DisputesPage } from '@/pages/DisputesPage';
import { SettingsPage } from '@/pages/SettingsPage';
import { LocalitiesPage } from '@/pages/LocalitiesPage';
import { Skeleton } from '@/components/ui';

// Top-level router. The auth store hydrates once on boot via
// bootstrapAuth() — until then we show a full-screen skeleton instead of
// flashing the login page for users who actually have a valid refresh cookie.
export function App() {
  useEffect(() => { void bootstrapAuth(); }, []);
  const isReady = useAuth((s) => s.isReady);
  const isAuthed = useAuth((s) => !!s.accessToken);

  if (!isReady) return <BootSkeleton />;

  return (
    <Routes>
      <Route path="/login" element={isAuthed ? <Navigate to="/" replace /> : <LoginPage />} />
      {isAuthed ? (
        <Route element={<Shell />}>
          <Route path="/"            element={<DashboardPage />} />
          <Route path="/flags"       element={<FlagsPage />} />
          <Route path="/sessions"    element={<SessionsPage />} />
          <Route path="/orders"      element={<OrdersPage />} />
          <Route path="/refunds"     element={<RefundsPage />} />
          <Route path="/users"       element={<UsersPage />} />
          <Route path="/workers"     element={<WorkersPage />} />
          <Route path="/leaves"      element={<LeavesPage />} />
          <Route path="/map"         element={<LiveMapPage />} />
          <Route path="/promos"      element={<PromosPage />} />
          <Route path="/banners"     element={<BannersPage />} />
          <Route path="/experiments" element={<ExperimentsPage />} />
          <Route path="/push"        element={<PushPage />} />
          <Route path="/analytics"   element={<AnalyticsPage />} />
          <Route path="/payouts"     element={<PayoutsPage />} />
          <Route path="/disputes"    element={<DisputesPage />} />
          <Route path="/settings"    element={<SettingsPage />} />
          <Route path="/localities"  element={<LocalitiesPage />} />
          <Route path="*"            element={<Navigate to="/" replace />} />
        </Route>
      ) : (
        <Route path="*" element={<Navigate to="/login" replace />} />
      )}
    </Routes>
  );
}

function BootSkeleton() {
  return (
    <div className="min-h-screen flex items-center justify-center">
      <div className="w-32 h-32 rounded-2xl bg-surface-elevated animate-pulse-soft" />
      <span className="sr-only">Loading…</span>
      <Skeleton className="hidden" />
    </div>
  );
}
