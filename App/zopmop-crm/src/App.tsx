import { lazy, useEffect } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';

import { bootstrapAuth } from '@/api/client';
import { useAuth } from '@/store/auth';

// Eager imports: anything in the initial paint path stays here.
//   * LoginPage — unauth users land here on cold load
//   * Shell + Sidebar/Topbar — always rendered around lazy routes
//   * Skeleton / BootSkeleton — Suspense fallbacks can't themselves be lazy
import { LoginPage } from '@/pages/auth/LoginPage';
import { Shell } from '@/components/shell/Shell';
import { Skeleton } from '@/components/ui';

// Lazy routes. The interop adapter (`then(m => ({ default: m.XxxPage }))`)
// translates our named exports into React.lazy's expected default-export
// shape. Each entry becomes its own chunk in the rollup output.
const DashboardPage     = lazy(() => import('./pages/DashboardPage').then(m => ({ default: m.DashboardPage })));
const FlagsPage         = lazy(() => import('./pages/FlagsPage').then(m => ({ default: m.FlagsPage })));
const SessionsPage      = lazy(() => import('./pages/SessionsPage').then(m => ({ default: m.SessionsPage })));
const UsersPage         = lazy(() => import('./pages/users/UsersPage').then(m => ({ default: m.UsersPage })));
const WorkersPage       = lazy(() => import('./pages/workers/WorkersPage').then(m => ({ default: m.WorkersPage })));
const WorkerNewPage     = lazy(() => import('./pages/workers/WorkerNewPage').then(m => ({ default: m.WorkerNewPage })));
const ZoneApprovalsPage = lazy(() => import('./pages/zoneApprovals/ZoneApprovalsPage').then(m => ({ default: m.ZoneApprovalsPage })));
const ShiftSessionsPage = lazy(() => import('./pages/shiftSessions/ShiftSessionsPage').then(m => ({ default: m.ShiftSessionsPage })));
const OrderDetailPage   = lazy(() => import('./pages/orders/OrderDetailPage').then(m => ({ default: m.OrderDetailPage })));
const AuditPage         = lazy(() => import('./pages/audit/AuditPage').then(m => ({ default: m.AuditPage })));
const LeavesPage        = lazy(() => import('./pages/LeavesPage').then(m => ({ default: m.LeavesPage })));
const LiveMapPage       = lazy(() => import('./pages/LiveMapPage').then(m => ({ default: m.LiveMapPage })));
const OrdersPage        = lazy(() => import('./pages/OrdersPage').then(m => ({ default: m.OrdersPage })));
const RefundsPage       = lazy(() => import('./pages/RefundsPage').then(m => ({ default: m.RefundsPage })));
const PromosPage        = lazy(() => import('./pages/PromosPage').then(m => ({ default: m.PromosPage })));
const CatalogPage       = lazy(() => import('./pages/CatalogPage').then(m => ({ default: m.CatalogPage })));
const BannersPage       = lazy(() => import('./pages/BannersPage').then(m => ({ default: m.BannersPage })));
const ExperimentsPage   = lazy(() => import('./pages/ExperimentsPage').then(m => ({ default: m.ExperimentsPage })));
const AnalyticsPage     = lazy(() => import('./pages/AnalyticsPage').then(m => ({ default: m.AnalyticsPage })));
const PushPage          = lazy(() => import('./pages/PushPage').then(m => ({ default: m.PushPage })));
const PayoutsPage       = lazy(() => import('./pages/PayoutsPage').then(m => ({ default: m.PayoutsPage })));
const DisputesPage      = lazy(() => import('./pages/DisputesPage').then(m => ({ default: m.DisputesPage })));
const SettingsPage      = lazy(() => import('./pages/SettingsPage').then(m => ({ default: m.SettingsPage })));
const LocalitiesPage    = lazy(() => import('./pages/LocalitiesPage').then(m => ({ default: m.LocalitiesPage })));
const SduiPagesPage         = lazy(() => import('./pages/SduiPagesPage').then(m => ({ default: m.SduiPagesPage })));
const SduiPageDetailPage    = lazy(() => import('./pages/SduiPageDetailPage').then(m => ({ default: m.SduiPageDetailPage })));
const SduiAllowedActionsPage = lazy(() => import('./pages/SduiAllowedActionsPage').then(m => ({ default: m.SduiAllowedActionsPage })));

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
          <Route path="/orders/:id"  element={<OrderDetailPage />} />
          <Route path="/refunds"     element={<RefundsPage />} />
          <Route path="/users"       element={<UsersPage />} />
          <Route path="/workers"     element={<WorkersPage />} />
          <Route path="/shift-sessions" element={<ShiftSessionsPage />} />
          <Route path="/workers/new" element={<WorkerNewPage />} />
          <Route path="/zone-approvals" element={<ZoneApprovalsPage />} />
          <Route path="/leaves"      element={<LeavesPage />} />
          <Route path="/map"         element={<LiveMapPage />} />
          <Route path="/promos"      element={<PromosPage />} />
          <Route path="/catalog"     element={<CatalogPage />} />
          <Route path="/banners"     element={<BannersPage />} />
          <Route path="/experiments" element={<ExperimentsPage />} />
          <Route path="/push"        element={<PushPage />} />
          <Route path="/analytics"   element={<AnalyticsPage />} />
          <Route path="/payouts"     element={<PayoutsPage />} />
          <Route path="/disputes"    element={<DisputesPage />} />
          <Route path="/audit"       element={<AuditPage />} />
          <Route path="/settings"    element={<SettingsPage />} />
          <Route path="/localities"  element={<LocalitiesPage />} />
          <Route path="/sdui"                 element={<SduiPagesPage />} />
          <Route path="/sdui/allowed-actions" element={<SduiAllowedActionsPage />} />
          <Route path="/sdui/:pageId"         element={<SduiPageDetailPage />} />
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
