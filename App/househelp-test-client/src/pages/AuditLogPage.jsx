import { useState, useEffect, useCallback } from 'react';
import { RefreshCw, ChevronLeft, ChevronRight, Search } from 'lucide-react';
import { getAuditLog } from '../api/admin.api';
import { useToast } from '../hooks/useToast';
import Toaster from '../components/Toast';

const TARGET_TYPES = ['', 'user', 'banner', 'config', 'booking', 'promotion', 'helper'];

const ACTION_COLORS = {
  suspend: 'text-red-400',
  unsuspend: 'text-green-400',
  delete: 'text-red-400',
  create: 'text-blue-400',
  update: 'text-yellow-400',
  disable: 'text-orange-400',
};

function actionColor(action) {
  for (const [key, cls] of Object.entries(ACTION_COLORS)) {
    if (action?.toLowerCase().includes(key)) return cls;
  }
  return 'text-gray-300';
}

export default function AuditLogPage() {
  const [logs, setLogs] = useState([]);
  const [total, setTotal] = useState(0);
  const [totalPages, setTotalPages] = useState(1);
  const [page, setPage] = useState(1);
  const [targetType, setTargetType] = useState('');
  const [loading, setLoading] = useState(false);
  const [expanded, setExpanded] = useState(null);
  const { toasts, toast } = useToast();

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = { page, limit: 30 };
      if (targetType) params.target_type = targetType;
      const res = await getAuditLog(params);
      setLogs(res.data || res.logs || []);
      setTotal(res.total_count || 0);
      setTotalPages(res.total_pages || 1);
    } catch {
      toast('Failed to load audit log', 'error');
    } finally {
      setLoading(false);
    }
  }, [page, targetType]);

  useEffect(() => { load(); }, [load]);

  const fmt = (iso) => {
    const d = new Date(iso);
    return d.toLocaleDateString() + ' ' + d.toLocaleTimeString();
  };

  const tryPretty = (raw) => {
    if (!raw || raw === 'null') return null;
    try { return JSON.stringify(JSON.parse(raw), null, 2); } catch { return String(raw); }
  };

  return (
    <div className="space-y-6">
      <Toaster toasts={toasts} />

      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-white">Audit Log</h1>
          <p className="text-gray-400 text-sm mt-0.5">{total.toLocaleString()} events</p>
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
      <div className="flex gap-1 bg-gray-800 rounded-lg p-1 w-fit">
        {TARGET_TYPES.map((t) => (
          <button
            key={t || 'all'}
            onClick={() => { setTargetType(t); setPage(1); }}
            className={`px-3 py-1.5 rounded-md text-xs font-medium transition-colors capitalize ${
              targetType === t ? 'bg-indigo-600 text-white' : 'text-gray-400 hover:text-white'
            }`}
          >
            {t || 'All'}
          </button>
        ))}
      </div>

      {/* Table */}
      <div className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-gray-800 text-xs text-gray-500 uppercase tracking-wide">
              <th className="text-left px-4 py-3 font-medium">Time</th>
              <th className="text-left px-4 py-3 font-medium">Admin</th>
              <th className="text-left px-4 py-3 font-medium">Action</th>
              <th className="text-left px-4 py-3 font-medium">Target</th>
              <th className="text-left px-4 py-3 font-medium">Change</th>
            </tr>
          </thead>
          <tbody>
            {loading && logs.length === 0 ? (
              <tr><td colSpan={5} className="text-center py-12 text-gray-500">Loading...</td></tr>
            ) : logs.length === 0 ? (
              <tr><td colSpan={5} className="text-center py-12 text-gray-500">No audit entries</td></tr>
            ) : (
              logs.map((log) => (
                <>
                  <tr
                    key={log.id}
                    onClick={() => setExpanded(expanded === log.id ? null : log.id)}
                    className="border-b border-gray-800/50 hover:bg-gray-800/30 transition-colors cursor-pointer"
                  >
                    <td className="px-4 py-3 text-xs text-gray-500 whitespace-nowrap">{fmt(log.created_at)}</td>
                    <td className="px-4 py-3 font-mono text-[10px] text-indigo-400 truncate max-w-[80px]">{log.admin_id?.slice(0, 8)}…</td>
                    <td className="px-4 py-3">
                      <span className={`font-semibold text-xs ${actionColor(log.action)}`}>{log.action}</span>
                    </td>
                    <td className="px-4 py-3">
                      <span className="px-2 py-0.5 bg-gray-800 text-gray-400 rounded text-xs">{log.target_type}</span>
                      <span className="ml-1 font-mono text-[10px] text-gray-600">{log.target_id?.slice(0, 6)}…</span>
                    </td>
                    <td className="px-4 py-3 text-xs text-gray-500 font-mono truncate max-w-[160px]">
                      {log.new_value && log.new_value !== 'null' ? `→ ${log.new_value}`.slice(0, 40) : '—'}
                    </td>
                  </tr>
                  {expanded === log.id && (
                    <tr key={`${log.id}-expanded`} className="border-b border-gray-800 bg-gray-950">
                      <td colSpan={5} className="px-6 py-4">
                        <div className="grid grid-cols-2 gap-4 text-xs">
                          <div>
                            <p className="text-gray-500 mb-1 uppercase tracking-wide text-[10px]">Old Value</p>
                            <pre className="text-gray-400 font-mono bg-gray-900 rounded-lg p-3 overflow-auto max-h-32">
                              {tryPretty(log.old_value) || '—'}
                            </pre>
                          </div>
                          <div>
                            <p className="text-gray-500 mb-1 uppercase tracking-wide text-[10px]">New Value</p>
                            <pre className="text-green-400 font-mono bg-gray-900 rounded-lg p-3 overflow-auto max-h-32">
                              {tryPretty(log.new_value) || '—'}
                            </pre>
                          </div>
                        </div>
                        <div className="mt-3 flex gap-6 text-[10px] text-gray-600 font-mono">
                          <span>ID: {log.id}</span>
                          <span>Target: {log.target_id}</span>
                          {log.ip_address && <span>IP: {log.ip_address}</span>}
                        </div>
                      </td>
                    </tr>
                  )}
                </>
              ))
            )}
          </tbody>
        </table>
      </div>

      {totalPages > 1 && (
        <div className="flex items-center justify-between text-sm text-gray-400">
          <span>Page {page} of {totalPages}</span>
          <div className="flex gap-2">
            <button onClick={() => setPage((p) => Math.max(1, p - 1))} disabled={page === 1 || loading} className="flex items-center gap-1 px-3 py-1.5 bg-gray-800 hover:bg-gray-700 rounded-lg disabled:opacity-40 transition-colors">
              <ChevronLeft size={14} /> Prev
            </button>
            <button onClick={() => setPage((p) => Math.min(totalPages, p + 1))} disabled={page === totalPages || loading} className="flex items-center gap-1 px-3 py-1.5 bg-gray-800 hover:bg-gray-700 rounded-lg disabled:opacity-40 transition-colors">
              Next <ChevronRight size={14} />
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
