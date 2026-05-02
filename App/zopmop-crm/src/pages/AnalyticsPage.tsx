import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Bar, BarChart, CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';

import { analyticsApi } from '@/api/all';
import { Card, EmptyState, Skeleton } from '@/components/ui';

const PRESETS: { label: string; days: number }[] = [
  { label: '7d',  days: 7 },
  { label: '30d', days: 30 },
  { label: '90d', days: 90 },
];
const fmt = (c: number) => '₹' + (c / 100).toLocaleString('en-IN', { maximumFractionDigits: 0 });

export function AnalyticsPage() {
  const [days, setDays] = useState(30);
  const params = useMemo(() => {
    const to = new Date().toISOString();
    const from = new Date(Date.now() - days * 86400000).toISOString();
    return { from, to };
  }, [days]);

  const summary = useQuery({ queryKey: ['analytics-summary', days], queryFn: () => analyticsApi.summary(params) });
  const revenue = useQuery({ queryKey: ['analytics-revenue', days], queryFn: () => analyticsApi.revenueDaily(params) });
  const orders  = useQuery({ queryKey: ['analytics-orders', days], queryFn: () => analyticsApi.ordersDaily(params) });
  const signups = useQuery({ queryKey: ['analytics-signups', days], queryFn: () => analyticsApi.signupsDaily(params) });
  const cats    = useQuery({ queryKey: ['analytics-cats', days], queryFn: () => analyticsApi.byCategory(params) });

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-end justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Analytics</h1>
          <p className="text-sm text-text-secondary mt-1">Read-only reporting on the dedicated read pool.</p>
        </div>
        <div className="flex gap-1 bg-surface border border-border rounded-xl p-1">
          {PRESETS.map((p) => (
            <button key={p.label} onClick={() => setDays(p.days)} className={`px-3 py-1.5 text-xs rounded-lg transition ${days === p.days ? 'bg-primary/15 text-primary' : 'text-text-secondary hover:text-text-primary'}`}>{p.label}</button>
          ))}
        </div>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Stat label="Orders"            value={summary.data?.orders} />
        <Stat label="Completed"         value={summary.data?.completed_orders} />
        <Stat label="Revenue"           value={summary.data ? fmt(summary.data.revenue_cents) : undefined} />
        <Stat label="Avg order"         value={summary.data ? fmt(summary.data.avg_order_cents) : undefined} />
        <Stat label="New customers"     value={summary.data?.new_users} />
        <Stat label="New pros"          value={summary.data?.new_workers} />
        <Stat label="Cancelled"         value={summary.data?.cancelled_orders} />
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <ChartCard title="Revenue / day" loading={revenue.isLoading} empty={(revenue.data?.length ?? 0) === 0}>
          <BarChart data={revenue.data ?? []}>
            <CartesianGrid strokeDasharray="3 3" stroke="#2A2A3A" vertical={false} />
            <XAxis dataKey="date" tick={{ fill: '#8888AA', fontSize: 10 }} />
            <YAxis tick={{ fill: '#8888AA', fontSize: 10 }} tickFormatter={(v) => '₹' + Math.round(v / 100).toLocaleString('en-IN')} />
            <Tooltip contentStyle={{ background: '#1A1A24', border: '1px solid #2A2A3A', borderRadius: 12 }} formatter={(v: number) => fmt(v)} />
            <Bar dataKey="value" fill="#6C63FF" radius={[6, 6, 0, 0]} />
          </BarChart>
        </ChartCard>

        <ChartCard title="Orders / day" loading={orders.isLoading} empty={(orders.data?.length ?? 0) === 0}>
          <LineChart data={orders.data ?? []}>
            <CartesianGrid strokeDasharray="3 3" stroke="#2A2A3A" vertical={false} />
            <XAxis dataKey="date" tick={{ fill: '#8888AA', fontSize: 10 }} />
            <YAxis tick={{ fill: '#8888AA', fontSize: 10 }} />
            <Tooltip contentStyle={{ background: '#1A1A24', border: '1px solid #2A2A3A', borderRadius: 12 }} />
            <Line type="monotone" dataKey="value" stroke="#00D4AA" strokeWidth={2} dot={false} />
          </LineChart>
        </ChartCard>

        <ChartCard title="Signups / day" loading={signups.isLoading} empty={(signups.data?.length ?? 0) === 0}>
          <LineChart data={signups.data ?? []}>
            <CartesianGrid strokeDasharray="3 3" stroke="#2A2A3A" vertical={false} />
            <XAxis dataKey="date" tick={{ fill: '#8888AA', fontSize: 10 }} />
            <YAxis tick={{ fill: '#8888AA', fontSize: 10 }} />
            <Tooltip contentStyle={{ background: '#1A1A24', border: '1px solid #2A2A3A', borderRadius: 12 }} />
            <Line type="monotone" dataKey="value" stroke="#FFB547" strokeWidth={2} dot={false} />
          </LineChart>
        </ChartCard>

        <Card>
          <h3 className="text-sm font-semibold mb-3">By category</h3>
          {cats.isLoading ? <Skeleton className="h-32" /> :
            (cats.data?.length ?? 0) === 0 ? <EmptyState title="No data" /> :
              <table className="w-full text-sm">
                <thead className="text-xs text-text-muted">
                  <tr><th className="text-left pb-1">Category</th><th className="text-right pb-1">Orders</th><th className="text-right pb-1">Revenue</th></tr>
                </thead>
                <tbody>
                  {cats.data?.map((r) => (
                    <tr key={r.category} className="border-t border-border">
                      <td className="py-2">{r.category}</td>
                      <td className="py-2 text-right tabular-nums">{r.orders}</td>
                      <td className="py-2 text-right tabular-nums">{fmt(r.revenue_cents)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
          }
        </Card>
      </div>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: number | string | undefined }) {
  return (
    <div className="card p-4">
      <div className="text-[11px] uppercase tracking-wider text-text-muted">{label}</div>
      <div className="text-xl font-semibold mt-1">{value ?? <Skeleton className="h-6 w-16 inline-block" />}</div>
    </div>
  );
}

function ChartCard({ title, loading, empty, children }: { title: string; loading: boolean; empty: boolean; children: React.ReactElement }) {
  return (
    <Card>
      <h3 className="text-sm font-semibold mb-3">{title}</h3>
      {loading ? <Skeleton className="h-48" /> :
        empty ? <EmptyState title="No data in range" /> :
          <ResponsiveContainer width="100%" height={200}>{children}</ResponsiveContainer>
      }
    </Card>
  );
}
