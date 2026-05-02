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
import { LiveMapPage } from '@/pages/LiveMapPage';
import { StubPage } from '@/pages/StubPage';
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
          <Route path="/"           element={<DashboardPage />} />
          <Route path="/flags"      element={<FlagsPage />} />
          <Route path="/sessions"   element={<SessionsPage />} />
          <Route path="/orders"     element={<StubPage name="Orders" description="Order lifecycle, refunds, manual interventions." />} />
          <Route path="/refunds"    element={<StubPage name="Refunds" description="Pending refund queue with approve/reject + partial-amount inputs." />} />
          <Route path="/users"      element={<UsersPage />} />
          <Route path="/workers"    element={<WorkersPage />} />
          <Route path="/map"        element={<LiveMapPage />} />
          <Route path="/promos"     element={<StubPage name="Promos" description="Promotional campaign builder with conflict detection and analytics." />} />
          <Route path="/banners"    element={<StubPage name="Banners" description="Visual home-screen editor with phone-frame live preview." />} />
          <Route path="/experiments" element={<StubPage name="A/B Tests" description="Experiment wizard with variants, metrics, and auto-pause on regressions." />} />
          <Route path="/push"       element={<StubPage name="Push" description="Push composer targeting users, pros, or both — with reach estimates." />} />
          <Route path="/analytics"  element={<StubPage name="Analytics" description="Read-only reporting routed through the read replica pool." />} />
          <Route path="/payouts"    element={<StubPage name="Payouts" description="Worker payout cycles, batch mark-paid, and bank-format exports." />} />
          <Route path="/disputes"   element={<StubPage name="Disputes" description="Case queue, GPS evidence, escalation chain, SLA timers." />} />
          <Route path="/settings"   element={<StubPage name="Settings" description="Per-admin profile + global settings (zones, surge, dynamic pricing)." />} />
          <Route path="*"           element={<Navigate to="/" replace />} />
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
