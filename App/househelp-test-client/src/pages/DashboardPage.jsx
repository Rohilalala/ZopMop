import { useEffect, useState } from 'react';
import { Users, Wrench, CalendarCheck, IndianRupee, Activity, CheckCircle, XCircle } from 'lucide-react';
import { getDashboard } from '../api/admin.api';
import { getAnalyticsOverview, getOperationalMetrics } from '../api/analytics.api';
import StatCard from '../components/StatCard';
import Toaster from '../components/Toast';
import { useToast } from '../hooks/useToast';
import client from '../api/client';

const fmt = (cents) => `₹${((cents || 0) / 100).toLocaleString('en-IN')}`;

export default function DashboardPage() {
  const { toasts, toast } = useToast();
  const [stats, setStats]    = useState(null);
  const [overview, setOverview] = useState(null);
  const [ops, setOps]        = useState(null);
  const [health, setHealth]  = useState(null); // 'ok' | 'error' | null
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;

    const load = async () => {
      try {
        const [s, o, op] = await Promise.allSettled([
          getDashboard(),
          getAnalyticsOverview(7),
          getOperationalMetrics(7),
        ]);
        if (cancelled) return;
        if (s.status === 'fulfilled')  setStats(s.value);
        if (o.status === 'fulfilled')  setOverview(o.value);
        if (op.status === 'fulfilled') setOps(op.value);
      } catch {
        if (!cancelled) toast('Failed to load dashboard data', 'error');
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    const checkHealth = async () => {
      try {
        await client.get('/health', { baseURL: 'http://localhost:8080' });
        if (!cancelled) setHealth('ok');
      } catch {
        if (!cancelled) setHealth('error');
      }
    };

    load();
    checkHealth();
    return () => { cancelled = true; };
  }, []);

  return (
    <div className="space-y-8">
      <Toaster toasts={toasts} />

      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-white">Dashboard</h1>
          <p className="text-gray-500 text-sm mt-0.5">Live overview of your platform</p>
        </div>
        <div className="flex items-center gap-2 text-sm">
          {health === 'ok'    && <span className="flex items-center gap-1.5 text-green-400"><CheckCircle size={14} /> API Online</span>}
          {health === 'error' && <span className="flex items-center gap-1.5 text-red-400"><XCircle size={14} /> API Offline</span>}
          {health === null    && <span className="flex items-center gap-1.5 text-gray-500"><Activity size={14} /> Checking…</span>}
        </div>
      </div>

      {/* Primary KPIs */}
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <StatCard
          title="Total Users"
          value={stats?.total_users?.toLocaleString()}
          sub={overview ? `+${overview.new_users} this week` : undefined}
          icon={<Users size={18} />}
          color="indigo"
          loading={loading}
        />
        <StatCard
          title="Total Workers"
          value={stats?.total_helpers?.toLocaleString()}
          sub={overview ? `${overview.active_helpers} online now` : undefined}
          icon={<Wrench size={18} />}
          color="blue"
          loading={loading}
        />
        <StatCard
          title="Active Bookings"
          value={stats?.active_bookings?.toLocaleString()}
          icon={<CalendarCheck size={18} />}
          color="amber"
          loading={loading}
        />
        <StatCard
          title="Revenue Today"
          value={fmt(stats?.revenue_today_cents)}
          icon={<IndianRupee size={18} />}
          color="green"
          loading={loading}
        />
      </div>

      {/* Analytics Overview (last 7 days) */}
      {overview && (
        <div>
          <h2 className="text-sm font-semibold text-gray-400 uppercase tracking-wider mb-3">Last 7 Days</h2>
          <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
            <StatCard
              title="Bookings Created"
              value={overview.total_bookings}
              icon={<CalendarCheck size={18} />}
              color="indigo"
            />
            <StatCard
              title="Completed"
              value={overview.completed_bookings}
              sub={`${overview.completion_rate?.toFixed(1)}% completion rate`}
              icon={<CheckCircle size={18} />}
              color="green"
            />
            <StatCard
              title="Cancelled"
              value={overview.cancelled_bookings}
              icon={<XCircle size={18} />}
              color="red"
            />
            <StatCard
              title="Net Revenue"
              value={fmt(overview.total_revenue_cents)}
              sub={`Avg: ${fmt(overview.avg_order_value_cents)}/booking`}
              icon={<IndianRupee size={18} />}
              color="green"
            />
          </div>
        </div>
      )}

      {/* Operational Metrics */}
      {ops && (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
          <div className="bg-gray-900 border border-gray-800 rounded-xl p-5">
            <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-1">Avg Time to Assign</p>
            <p className="text-2xl font-bold text-white">
              {ops.avg_time_to_assign_seconds > 0
                ? `${ops.avg_time_to_assign_seconds.toFixed(0)}s`
                : '—'}
            </p>
            <p className="text-xs text-gray-500 mt-1">From booking created → helper accepted</p>
          </div>
          <div className="bg-gray-900 border border-gray-800 rounded-xl p-5">
            <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-1">Match Success Rate</p>
            <p className="text-2xl font-bold text-white">{ops.match_success_rate?.toFixed(1)}%</p>
            <p className="text-xs text-gray-500 mt-1">Bookings that got a helper assigned</p>
          </div>
          <div className="bg-gray-900 border border-gray-800 rounded-xl p-5">
            <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-1">Auto-Expired Bookings</p>
            <p className="text-2xl font-bold text-white">{ops.auto_expired_bookings}</p>
            <p className="text-xs text-gray-500 mt-1">No helper found in time (system cancelled)</p>
          </div>
        </div>
      )}
    </div>
  );
}
