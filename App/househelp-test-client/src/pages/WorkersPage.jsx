import { useState, useEffect, useCallback } from 'react';
import { RefreshCw, ChevronLeft, ChevronRight, MapPin, Star } from 'lucide-react';
import { getHelpers } from '../api/admin.api';
import { getWorkerPerformance } from '../api/analytics.api';
import StatusBadge from '../components/StatusBadge';
import { useToast } from '../hooks/useToast';
import Toaster from '../components/Toast';

function ratingColor(r) {
  if (r >= 4.5) return 'text-green-400';
  if (r >= 3.5) return 'text-yellow-400';
  if (r === 0) return 'text-gray-600';
  return 'text-red-400';
}

function completionColor(r) {
  if (r >= 80) return 'text-green-400';
  if (r >= 60) return 'text-yellow-400';
  return 'text-red-400';
}

export default function WorkersPage() {
  const [helpers, setHelpers] = useState([]);
  const [total, setTotal] = useState(0);
  const [totalPages, setTotalPages] = useState(1);
  const [page, setPage] = useState(1);
  const [availableOnly, setAvailableOnly] = useState(false);
  const [perfMap, setPerfMap] = useState({});
  const [loading, setLoading] = useState(false);
  const { toasts, toast } = useToast();

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = { page, limit: 25 };
      if (availableOnly) params.available = 'true';
      const [helpersRes, perfRes] = await Promise.allSettled([
        getHelpers(params),
        getWorkerPerformance(30, 100),
      ]);

      if (helpersRes.status === 'fulfilled') {
        const res = helpersRes.value;
        setHelpers(res.data || res.helpers || []);
        setTotal(res.total_count || 0);
        setTotalPages(res.total_pages || 1);
      } else {
        toast('Failed to load workers', 'error');
      }

      if (perfRes.status === 'fulfilled' && Array.isArray(perfRes.value)) {
        const map = {};
        perfRes.value.forEach((w) => { map[w.helper_id] = w; });
        setPerfMap(map);
      }
    } finally {
      setLoading(false);
    }
  }, [page, availableOnly]);

  useEffect(() => { load(); }, [load]);

  return (
    <div className="space-y-6">
      <Toaster toasts={toasts} />

      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-white">Workers</h1>
          <p className="text-gray-400 text-sm mt-0.5">{total.toLocaleString()} helpers</p>
        </div>
        <button
          onClick={load}
          disabled={loading}
          className="flex items-center gap-2 px-3 py-2 bg-gray-800 hover:bg-gray-700 text-gray-300 rounded-lg text-sm transition-colors disabled:opacity-50"
        >
          <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
          Refresh
        </button>
      </div>

      {/* Filter */}
      <div className="flex items-center gap-3">
        <label className="flex items-center gap-2 cursor-pointer select-none">
          <input
            type="checkbox"
            checked={availableOnly}
            onChange={(e) => { setAvailableOnly(e.target.checked); setPage(1); }}
            className="w-4 h-4 accent-indigo-500"
          />
          <span className="text-sm text-gray-300">Available only</span>
        </label>
      </div>

      {/* Table */}
      <div className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-gray-800 text-xs text-gray-500 uppercase tracking-wide">
              <th className="text-left px-4 py-3 font-medium">Name</th>
              <th className="text-left px-4 py-3 font-medium">Phone</th>
              <th className="text-left px-4 py-3 font-medium">Availability</th>
              <th className="text-left px-4 py-3 font-medium">Rating</th>
              <th className="text-left px-4 py-3 font-medium">Jobs</th>
              <th className="text-left px-4 py-3 font-medium">Completion</th>
              <th className="text-left px-4 py-3 font-medium">Avg Job</th>
              <th className="text-left px-4 py-3 font-medium">Location</th>
            </tr>
          </thead>
          <tbody>
            {loading && helpers.length === 0 ? (
              <tr><td colSpan={8} className="text-center py-12 text-gray-500">Loading...</td></tr>
            ) : helpers.length === 0 ? (
              <tr><td colSpan={8} className="text-center py-12 text-gray-500">No workers found</td></tr>
            ) : (
              helpers.map((h) => {
                const perf = perfMap[h.id] || null;
                return (
                  <tr key={h.id} className="border-b border-gray-800/50 hover:bg-gray-800/30 transition-colors">
                    <td className="px-4 py-3 text-white font-medium">{h.name || <span className="text-gray-600">—</span>}</td>
                    <td className="px-4 py-3 text-gray-300">{h.phone}</td>
                    <td className="px-4 py-3">
                      <StatusBadge status={h.is_available ? 'available' : 'busy'} />
                    </td>
                    <td className="px-4 py-3">
                      <span className={`flex items-center gap-1 font-medium ${ratingColor(h.rating)}`}>
                        {h.rating > 0 ? (
                          <><Star size={12} fill="currentColor" />{h.rating.toFixed(1)}</>
                        ) : '—'}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-gray-300">{h.total_jobs}</td>
                    <td className="px-4 py-3">
                      {perf ? (
                        <span className={`font-medium ${completionColor(perf.completion_rate)}`}>
                          {perf.completion_rate.toFixed(0)}%
                        </span>
                      ) : <span className="text-gray-600">—</span>}
                    </td>
                    <td className="px-4 py-3 text-gray-400">
                      {perf?.avg_job_min ? `${perf.avg_job_min.toFixed(0)}m` : <span className="text-gray-600">—</span>}
                    </td>
                    <td className="px-4 py-3">
                      {h.current_lat && h.current_lng ? (
                        <span className="flex items-center gap-1 text-xs text-green-400">
                          <MapPin size={11} />
                          {h.current_lat.toFixed(3)}, {h.current_lng.toFixed(3)}
                        </span>
                      ) : (
                        <span className="text-gray-600 text-xs">offline</span>
                      )}
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>

      {totalPages > 1 && (
        <div className="flex items-center justify-between text-sm text-gray-400">
          <span>Page {page} of {totalPages}</span>
          <div className="flex gap-2">
            <button
              onClick={() => setPage((p) => Math.max(1, p - 1))}
              disabled={page === 1 || loading}
              className="flex items-center gap-1 px-3 py-1.5 bg-gray-800 hover:bg-gray-700 rounded-lg disabled:opacity-40 transition-colors"
            >
              <ChevronLeft size={14} /> Prev
            </button>
            <button
              onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
              disabled={page === totalPages || loading}
              className="flex items-center gap-1 px-3 py-1.5 bg-gray-800 hover:bg-gray-700 rounded-lg disabled:opacity-40 transition-colors"
            >
              Next <ChevronRight size={14} />
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
