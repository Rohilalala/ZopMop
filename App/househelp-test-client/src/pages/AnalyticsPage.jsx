import { useEffect, useState } from 'react';
import { BarChart2, TrendingUp, Users, IndianRupee } from 'lucide-react';
import {
  getAnalyticsOverview, getAnalyticsFunnel, getBookingTrends,
  getWorkerPerformance, getRevenueTrends,
} from '../api/analytics.api';
import BarChart from '../components/BarChart';
import Toaster from '../components/Toast';
import { useToast } from '../hooks/useToast';

const PERIODS = [7, 30, 90];
const fmt = (cents) => `₹${((cents || 0) / 100).toLocaleString('en-IN')}`;

function Section({ title, children, action }) {
  return (
    <div className="bg-gray-900 border border-gray-800 rounded-xl p-6">
      <div className="flex items-center justify-between mb-5">
        <h2 className="text-sm font-semibold text-white">{title}</h2>
        {action}
      </div>
      {children}
    </div>
  );
}

export default function AnalyticsPage() {
  const { toasts, toast } = useToast();
  const [days, setDays] = useState(30);
  const [funnel, setFunnel]    = useState(null);
  const [trends, setTrends]    = useState(null);
  const [workers, setWorkers]  = useState(null);
  const [revenue, setRevenue]  = useState(null);
  const [loading, setLoading]  = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);

    Promise.allSettled([
      getAnalyticsFunnel(days),
      getBookingTrends(days),
      getWorkerPerformance(days, 15),
      getRevenueTrends(days),
    ]).then(([f, t, w, r]) => {
      if (cancelled) return;
      if (f.status === 'fulfilled') setFunnel(f.value);
      if (t.status === 'fulfilled') setTrends(t.value);
      if (w.status === 'fulfilled') setWorkers(w.value);
      if (r.status === 'fulfilled') setRevenue(r.value);
      setLoading(false);
    }).catch(() => {
      if (!cancelled) { toast('Failed to load analytics', 'error'); setLoading(false); }
    });

    return () => { cancelled = true; };
  }, [days]);

  const PeriodSelector = (
    <div className="flex gap-1 bg-gray-800 rounded-lg p-1">
      {PERIODS.map(d => (
        <button
          key={d}
          onClick={() => setDays(d)}
          className={`px-3 py-1 text-xs font-medium rounded-md transition-colors ${
            days === d ? 'bg-indigo-600 text-white' : 'text-gray-400 hover:text-white'
          }`}
        >
          {d}d
        </button>
      ))}
    </div>
  );

  const trendData = (trends?.trends || []).map(d => ({
    label: d.date?.slice(5),   // MM-DD
    value: d.created,
    value2: d.completed,
  }));

  const revenueData = (revenue?.revenue || []).map(d => ({
    label: d.date?.slice(5),
    value: (d.net_revenue_cents || 0) / 100,
  }));

  return (
    <div className="space-y-8">
      <Toaster toasts={toasts} />

      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-white">Analytics</h1>
          <p className="text-gray-500 text-sm mt-0.5">Booking funnel, trends, and worker performance</p>
        </div>
        {PeriodSelector}
      </div>

      {loading && (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          {[...Array(4)].map((_, i) => (
            <div key={i} className="bg-gray-900 border border-gray-800 rounded-xl h-48 animate-pulse" />
          ))}
        </div>
      )}

      {!loading && (
        <>
          {/* Booking Funnel */}
          {funnel && (
            <Section title="Booking Conversion Funnel" action={<span className="text-xs text-gray-500">Last {days} days</span>}>
              <div className="space-y-3">
                {funnel.steps?.map((step, i) => {
                  const max = funnel.steps[0]?.count || 1;
                  const pct = max > 0 ? (step.count / max) * 100 : 0;
                  return (
                    <div key={i}>
                      <div className="flex items-center justify-between text-xs mb-1">
                        <span className="text-gray-300 font-medium">{step.step}</span>
                        <div className="flex items-center gap-3">
                          <span className="text-gray-400">{step.count.toLocaleString()} users</span>
                          {i > 0 && (
                            <span className={`font-semibold ${step.conversion_pct >= 60 ? 'text-green-400' : step.conversion_pct >= 30 ? 'text-amber-400' : 'text-red-400'}`}>
                              {step.conversion_pct?.toFixed(1)}%
                            </span>
                          )}
                        </div>
                      </div>
                      <div className="h-2 bg-gray-800 rounded-full overflow-hidden">
                        <div
                          className="h-full bg-indigo-600 rounded-full transition-all duration-500"
                          style={{ width: `${pct}%` }}
                        />
                      </div>
                    </div>
                  );
                })}
              </div>
            </Section>
          )}

          {/* Booking Trends Chart */}
          {trendData.length > 0 && (
            <Section title="Booking Trends — Created vs Completed">
              <div className="flex gap-4 text-xs mb-4">
                <span className="flex items-center gap-1.5"><span className="w-3 h-3 rounded-sm bg-indigo-500 inline-block" /> Created</span>
                <span className="flex items-center gap-1.5"><span className="w-3 h-3 rounded-sm bg-emerald-500 inline-block" /> Completed</span>
              </div>
              <BarChart
                data={trendData}
                height={160}
                color="fill-indigo-500"
                color2="fill-emerald-500"
              />
            </Section>
          )}

          {/* Revenue Trends */}
          {revenueData.length > 0 && (
            <Section title="Net Revenue Trend">
              <BarChart
                data={revenueData}
                height={140}
                color="fill-green-500"
                formatY={(v) => `₹${Number(v).toLocaleString('en-IN')}`}
              />
              {revenue?.revenue && (
                <div className="mt-4 pt-4 border-t border-gray-800 grid grid-cols-3 gap-4 text-center">
                  <div>
                    <p className="text-xs text-gray-500">Total Gross</p>
                    <p className="text-base font-bold text-white">
                      {fmt(revenue.revenue.reduce((s, d) => s + d.gross_revenue_cents, 0))}
                    </p>
                  </div>
                  <div>
                    <p className="text-xs text-gray-500">Total Discounts</p>
                    <p className="text-base font-bold text-red-400">
                      -{fmt(revenue.revenue.reduce((s, d) => s + d.discount_cents, 0))}
                    </p>
                  </div>
                  <div>
                    <p className="text-xs text-gray-500">Net Revenue</p>
                    <p className="text-base font-bold text-green-400">
                      {fmt(revenue.revenue.reduce((s, d) => s + d.net_revenue_cents, 0))}
                    </p>
                  </div>
                </div>
              )}
            </Section>
          )}

          {/* Worker Performance */}
          {workers?.workers?.length > 0 && (
            <Section title="Worker Performance">
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-xs text-gray-500 uppercase tracking-wide border-b border-gray-800">
                      <th className="text-left pb-3 font-medium">Worker</th>
                      <th className="text-right pb-3 font-medium">Assigned</th>
                      <th className="text-right pb-3 font-medium">Completed</th>
                      <th className="text-right pb-3 font-medium">Cancelled</th>
                      <th className="text-right pb-3 font-medium">Completion</th>
                      <th className="text-right pb-3 font-medium">Avg Response</th>
                      <th className="text-right pb-3 font-medium">Rating</th>
                    </tr>
                  </thead>
                  <tbody>
                    {workers.workers.map(w => (
                      <tr key={w.helper_id} className="border-b border-gray-800/50 hover:bg-gray-800/30">
                        <td className="py-3 text-white font-medium">{w.name || w.helper_id.slice(0, 8) + '…'}</td>
                        <td className="py-3 text-right text-gray-300">{w.total_assigned}</td>
                        <td className="py-3 text-right text-green-400">{w.total_completed}</td>
                        <td className="py-3 text-right text-red-400">{w.total_cancelled}</td>
                        <td className="py-3 text-right">
                          <span className={`font-semibold ${w.completion_rate >= 70 ? 'text-green-400' : w.completion_rate >= 40 ? 'text-amber-400' : 'text-red-400'}`}>
                            {w.completion_rate?.toFixed(0)}%
                          </span>
                        </td>
                        <td className="py-3 text-right text-gray-400">
                          {w.avg_response_seconds > 0 ? `${w.avg_response_seconds.toFixed(0)}s` : '—'}
                        </td>
                        <td className="py-3 text-right text-amber-400">★ {w.rating?.toFixed(1)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Section>
          )}

          {!funnel && !trendData.length && !workers?.workers?.length && (
            <div className="text-center py-16 text-gray-600">
              <BarChart2 size={32} className="mx-auto mb-3 opacity-40" />
              <p>No analytics data for this period yet.</p>
              <p className="text-sm mt-1">Data populates as bookings flow through the system.</p>
            </div>
          )}
        </>
      )}
    </div>
  );
}
