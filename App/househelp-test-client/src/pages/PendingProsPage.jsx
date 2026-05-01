import { useState, useEffect, useCallback } from 'react';
import { RefreshCw, ChevronLeft, ChevronRight, Check, X } from 'lucide-react';
import { getPendingHelpers, approveHelper, rejectHelper } from '../api/admin.api';
import Modal from '../components/Modal';
import { useToast } from '../hooks/useToast';
import Toaster from '../components/Toast';

const PAGE_SIZES = [10, 25, 50, 100];

export default function PendingProsPage() {
  const [helpers, setHelpers] = useState([]);
  const [total, setTotal] = useState(0);
  const [totalPages, setTotalPages] = useState(1);
  const [page, setPage] = useState(1);
  const [limit, setLimit] = useState(25);
  const [loading, setLoading] = useState(false);
  const [busyIds, setBusyIds] = useState({});
  const [confirmReject, setConfirmReject] = useState(null);
  const { toasts, toast } = useToast();

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await getPendingHelpers({ page, limit });
      setHelpers(res.data || []);
      setTotal(res.total_count || 0);
      setTotalPages(res.total_pages || 1);
    } catch {
      toast('Failed to load pending pros', 'error');
    } finally {
      setLoading(false);
    }
  }, [page, limit, toast]);

  useEffect(() => { load(); }, [load]);

  const handleApprove = async (helper) => {
    setBusyIds((prev) => ({ ...prev, [helper.id]: 'approving' }));
    // Optimistic remove from list — backend will confirm via refetch.
    setHelpers((prev) => prev.filter((h) => h.id !== helper.id));
    try {
      await approveHelper(helper.id);
      toast(`Approved ${helper.phone}`);
      load();
    } catch {
      toast('Approve failed', 'error');
      load();
    } finally {
      setBusyIds((prev) => {
        const next = { ...prev }; delete next[helper.id]; return next;
      });
    }
  };

  const handleReject = async () => {
    const helper = confirmReject;
    if (!helper) return;
    setConfirmReject(null);
    setBusyIds((prev) => ({ ...prev, [helper.id]: 'rejecting' }));
    setHelpers((prev) => prev.filter((h) => h.id !== helper.id));
    try {
      await rejectHelper(helper.id);
      toast(`Rejected ${helper.phone}`);
      load();
    } catch {
      toast('Reject failed', 'error');
      load();
    } finally {
      setBusyIds((prev) => {
        const next = { ...prev }; delete next[helper.id]; return next;
      });
    }
  };

  return (
    <div className="space-y-6">
      <Toaster toasts={toasts} />

      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-white">Pending Pros</h1>
          <p className="text-gray-400 text-sm mt-0.5">
            {total.toLocaleString()} awaiting approval
          </p>
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

      <div className="flex items-center gap-3 text-sm text-gray-400">
        <label className="flex items-center gap-2">
          Page size
          <select
            value={limit}
            onChange={(e) => { setLimit(Number(e.target.value)); setPage(1); }}
            className="bg-gray-800 border border-gray-700 rounded px-2 py-1 text-gray-200"
          >
            {PAGE_SIZES.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
        </label>
      </div>

      <div className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-gray-800 text-xs text-gray-500 uppercase tracking-wide">
              <th className="text-left px-4 py-3 font-medium">Name</th>
              <th className="text-left px-4 py-3 font-medium">Phone</th>
              <th className="text-left px-4 py-3 font-medium">Helper ID</th>
              <th className="text-right px-4 py-3 font-medium">Actions</th>
            </tr>
          </thead>
          <tbody>
            {loading && helpers.length === 0 ? (
              <tr><td colSpan={4} className="text-center py-12 text-gray-500">Loading...</td></tr>
            ) : helpers.length === 0 ? (
              <tr><td colSpan={4} className="text-center py-12 text-gray-500">No pros awaiting approval</td></tr>
            ) : (
              helpers.map((h) => {
                const busy = busyIds[h.id];
                return (
                  <tr key={h.id} className="border-b border-gray-800/50 hover:bg-gray-800/30 transition-colors">
                    <td className="px-4 py-3 text-white font-medium">
                      {h.name || <span className="text-gray-600">—</span>}
                    </td>
                    <td className="px-4 py-3 text-gray-300">{h.phone}</td>
                    <td className="px-4 py-3 text-gray-500 font-mono text-xs">{h.id.slice(0, 8)}…</td>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-2 justify-end">
                        <button
                          onClick={() => handleApprove(h)}
                          disabled={!!busy}
                          className="flex items-center gap-1 px-3 py-1.5 bg-green-600/15 hover:bg-green-600/25 text-green-400 rounded-md text-xs font-medium transition-colors disabled:opacity-40"
                        >
                          <Check size={12} /> {busy === 'approving' ? 'Approving…' : 'Approve'}
                        </button>
                        <button
                          onClick={() => setConfirmReject(h)}
                          disabled={!!busy}
                          className="flex items-center gap-1 px-3 py-1.5 bg-red-600/15 hover:bg-red-600/25 text-red-400 rounded-md text-xs font-medium transition-colors disabled:opacity-40"
                        >
                          <X size={12} /> {busy === 'rejecting' ? 'Rejecting…' : 'Reject'}
                        </button>
                      </div>
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

      <Modal
        open={!!confirmReject}
        onClose={() => setConfirmReject(null)}
        title="Reject pro?"
      >
        <p className="text-sm text-gray-300">
          Reject <span className="font-semibold text-white">{confirmReject?.phone}</span>?
          This sets approval_status to <code className="text-rose-300">rejected</code> and
          they will not be able to take jobs. This action is logged.
        </p>
        <div className="flex justify-end gap-2 mt-5">
          <button
            onClick={() => setConfirmReject(null)}
            className="px-3 py-1.5 bg-gray-800 hover:bg-gray-700 text-gray-200 rounded-lg text-sm"
          >
            Cancel
          </button>
          <button
            onClick={handleReject}
            className="px-3 py-1.5 bg-red-600 hover:bg-red-500 text-white rounded-lg text-sm font-medium"
          >
            Reject
          </button>
        </div>
      </Modal>
    </div>
  );
}
