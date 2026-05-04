import { useQuery } from '@tanstack/react-query';
import { motion } from 'framer-motion';
import {
  Briefcase, Users as UsersIcon, IndianRupee, RefreshCw,
  UserPlus, ShieldAlert,
} from 'lucide-react';
import {
  Bar, BarChart, CartesianGrid, ResponsiveContainer,
  Tooltip, XAxis, YAxis, PieChart, Pie, Cell, Legend,
} from 'recharts';

import {
  fetchKpis, fetchLiveOrders, fetchRevenue7d, fetchCategoryShare, fetchAlerts,
  type KPIs,
} from '@/api/dashboard';
import { Card, EmptyState, Skeleton, StatusPill } from '@/components/ui';
import { HealthStrip } from '@/components/dashboard/HealthStrip';
import { QuickActions } from '@/components/dashboard/QuickActions';
import { MiniWorkerMap } from '@/components/dashboard/MiniWorkerMap';

// Dashboard: top-row KPIs, mid-row revenue + category-share charts, bottom
// row live-orders feed + alerts feed. Auto-refreshes every 10s without
// causing layout shift (React Query keeps prior data while refetching).

const fmtCents = (n?: number) =>
  n == null ? '—' : '₹' + (n / 100).toLocaleString('en-IN', { maximumFractionDigits: 0 });

export function DashboardPage() {
  const kpis = useQuery({ queryKey: ['kpis'], queryFn: fetchKpis, refetchInterval: 10_000 });
  return (
    <div className="p-6 space-y-6">
      <HealthStrip />

      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Dashboard</h1>
        <p className="text-sm text-text-secondary mt-1">Live operations overview.</p>
      </div>

      <QuickActions />

      <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
        <KpiCard label="Active orders"      icon={Briefcase}     loading={kpis.isLoading} value={kpis.data?.active_orders} />
        <KpiCard label="Workers online"     icon={UsersIcon}     loading={kpis.isLoading} value={kpis.data?.workers_online} />
        <KpiCard label="Revenue today"      icon={IndianRupee}   loading={kpis.isLoading} value={kpis.data && fmtCents(kpis.data.revenue_today_cents)} />
        <KpiCard label="Pending refunds"    icon={RefreshCw}     loading={kpis.isLoading} value={kpis.data?.pending_refunds} tone="warning" />
        <KpiCard label="Worker applications" icon={UserPlus}     loading={kpis.isLoading} value={kpis.data?.pending_applications} />
        <KpiCard label="Open disputes"      icon={ShieldAlert}   loading={kpis.isLoading} value={kpis.data?.open_disputes} tone="danger" />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <RevenueChart />
        <CategoryDonut />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <LiveOrdersFeed />
        <AlertsFeed />
      </div>

      <MiniWorkerMap />
    </div>
  );
}

function KpiCard({
  label, icon: Icon, value, loading, tone = 'info',
}: {
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  value?: KPIs[keyof KPIs] | string;
  loading: boolean;
  tone?: 'info' | 'warning' | 'danger';
}) {
  const ringColor = tone === 'danger' ? 'border-danger/30' : tone === 'warning' ? 'border-warning/30' : 'border-border';
  return (
    <motion.div
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      className={`card p-5 border ${ringColor}`}
    >
      <div className="flex items-center justify-between mb-3">
        <span className="text-xs uppercase tracking-wider text-text-muted">{label}</span>
        <Icon className="w-4 h-4 text-text-muted" />
      </div>
      {loading ? (
        <Skeleton className="h-8 w-24" />
      ) : (
        <div className="text-3xl font-semibold tracking-tight">{value ?? '—'}</div>
      )}
    </motion.div>
  );
}

function RevenueChart() {
  const q = useQuery({ queryKey: ['revenue7d'], queryFn: fetchRevenue7d, refetchInterval: 60_000 });
  return (
    <Card className="lg:col-span-2 min-h-[260px]">
      <div className="mb-3 flex items-center justify-between">
        <h3 className="text-sm font-semibold">Revenue · last 7 days</h3>
        <span className="text-xs text-text-muted">₹</span>
      </div>
      {q.isLoading ? (
        <Skeleton className="h-48" />
      ) : (q.data ?? []).every((p) => p.revenue_cents === 0) ? (
        <EmptyState title="No revenue yet" body="Completed orders will appear here." />
      ) : (
        <ResponsiveContainer width="100%" height={220}>
          <BarChart data={q.data ?? []}>
            <CartesianGrid strokeDasharray="3 3" stroke="#2A2A3A" vertical={false} />
            <XAxis dataKey="date" tick={{ fill: '#8888AA', fontSize: 11 }} axisLine={{ stroke: '#2A2A3A' }} />
            <YAxis
              tick={{ fill: '#8888AA', fontSize: 11 }}
              axisLine={{ stroke: '#2A2A3A' }}
              tickFormatter={(v) => '₹' + Math.round(v / 100).toLocaleString('en-IN')}
            />
            <Tooltip
              contentStyle={{ background: '#1A1A24', border: '1px solid #2A2A3A', borderRadius: 12 }}
              labelStyle={{ color: '#F0F0FF' }}
              formatter={(v: number) => fmtCents(v)}
            />
            <Bar dataKey="revenue_cents" fill="#6C63FF" radius={[6, 6, 0, 0]} />
          </BarChart>
        </ResponsiveContainer>
      )}
    </Card>
  );
}

const DONUT_COLORS = ['#6C63FF', '#00D4AA', '#FFB547', '#FF4D6A', '#8888AA', '#4A4A6A'];

function CategoryDonut() {
  const q = useQuery({ queryKey: ['categoryShare'], queryFn: fetchCategoryShare, refetchInterval: 60_000 });
  return (
    <Card>
      <h3 className="text-sm font-semibold mb-3">Categories · today</h3>
      {q.isLoading ? (
        <Skeleton className="h-48" />
      ) : (q.data?.length ?? 0) === 0 ? (
        <EmptyState title="No orders yet today" />
      ) : (
        <ResponsiveContainer width="100%" height={220}>
          <PieChart>
            <Pie
              data={q.data}
              dataKey="count"
              nameKey="category"
              innerRadius={50}
              outerRadius={80}
              paddingAngle={2}
            >
              {(q.data ?? []).map((_, i) => (
                <Cell key={i} fill={DONUT_COLORS[i % DONUT_COLORS.length]} stroke="none" />
              ))}
            </Pie>
            <Legend
              wrapperStyle={{ fontSize: 11, color: '#8888AA' }}
              iconSize={8}
              iconType="circle"
            />
          </PieChart>
        </ResponsiveContainer>
      )}
    </Card>
  );
}

function LiveOrdersFeed() {
  const q = useQuery({ queryKey: ['liveOrders'], queryFn: fetchLiveOrders, refetchInterval: 10_000 });
  return (
    <Card>
      <h3 className="text-sm font-semibold mb-3">Live orders</h3>
      {q.isLoading ? (
        <div className="space-y-2">
          <Skeleton className="h-10" />
          <Skeleton className="h-10" />
          <Skeleton className="h-10" />
        </div>
      ) : (q.data?.length ?? 0) === 0 ? (
        <EmptyState title="No active orders" body="When orders come in they'll show up here in real time." />
      ) : (
        <div className="divide-y divide-border max-h-[360px] overflow-y-auto -mx-1">
          {q.data?.map((o) => (
            <div key={o.id} className="flex items-center gap-3 px-1 py-2.5">
              <div className="flex-1 min-w-0">
                <div className="text-sm text-text-primary truncate">
                  {o.user_name} · {o.category}
                </div>
                <div className="text-[11px] text-text-secondary truncate">
                  {o.helper_name ?? 'unassigned'} · {new Date(o.created_at).toLocaleTimeString()}
                </div>
              </div>
              <StatusBadge status={o.status} />
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}

function StatusBadge({ status }: { status: string }) {
  const tone =
    status === 'completed' ? 'success'
    : status === 'in_progress' || status === 'arrived' ? 'info'
    : status === 'cancelled' ? 'danger'
    : status === 'pending' ? 'warning'
    : 'neutral';
  return <StatusPill tone={tone}>{status}</StatusPill>;
}

function AlertsFeed() {
  const q = useQuery({ queryKey: ['alerts'], queryFn: fetchAlerts, refetchInterval: 15_000 });
  return (
    <Card>
      <div className="mb-3 flex items-center justify-between">
        <h3 className="text-sm font-semibold">Alerts</h3>
      </div>
      {q.isLoading ? (
        <div className="space-y-2">
          <Skeleton className="h-10" /><Skeleton className="h-10" />
        </div>
      ) : (q.data?.length ?? 0) === 0 ? (
        <EmptyState title="All clear" body="No alerts in the feed right now." />
      ) : (
        <div className="divide-y divide-border max-h-[360px] overflow-y-auto -mx-1">
          {q.data?.map((a) => (
            <div key={a.id} className="px-1 py-2.5 flex items-start gap-3">
              <span
                className={`mt-1.5 w-1.5 h-1.5 rounded-full shrink-0 ${
                  a.severity === 'error' ? 'bg-danger'
                  : a.severity === 'warning' ? 'bg-warning'
                  : 'bg-primary'
                }`}
              />
              <div className="flex-1 min-w-0">
                <div className="text-sm text-text-primary">{a.message}</div>
                <div className="text-[11px] text-text-secondary">
                  {a.source} · {new Date(a.created_at).toLocaleString()}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}
