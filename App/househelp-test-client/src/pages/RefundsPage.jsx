import { useState, useEffect, useCallback } from 'react';
import { RefreshCw, ChevronLeft, ChevronRight, Check } from 'lucide-react';
import { listRefunds, settleRefund } from '../api/admin.api';
import Modal from '../components/Modal';
import { useToast } from '../hooks/useToast';
import Toaster from '../components/Toast';

const PAGE_SIZES = [10, 25, 50, 100];

function formatRupees(cents) {
  return `₹${(Number(cents || 0) / 100).toFixed(0)}`;
}

function formatDate(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  return d.toLocaleString();
}

export default function RefundsPage() {
  const [tab, setTab] = useState('pending'); // 'pending' | 'settled'
  const [refunds, setRefunds] = useState([]);
  const [total, setTotal] = useState(0);
  const [totalPages, setTotalPages] = useState(1);
  const [page, setPage] = useState(1);
  const [limit, setLimit] = useState(25);
  const [loading, setLoading] = useState(false);
  const [busyIds, setBusyIds] = useState({});
  const [confirmSettle, setConfirmSettle] = useState(null);
  const { toasts, toast } = useToast();

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await listRefunds({ status: tab, page, limit });
      setRefunds(res.data || []);
      setTotal(res.total_count || 0);
      setTotalPages(res.total_pages || 1);
    } catch {
      toast('Failed to load refunds', 'error');
    } finally {
      setLoading(false);
    }
  }, [tab, page, limit, toast]);

  useEffect(() => { load(); }, [load]);

  // Reset to page 1 when tab changes.
  useEffect(() => { setPage(1); }, [tab]);

  const handleSettle = async () => {
    const r = confirmSettle;
    if (!r) return;
    setConfirmSettle(null);
    setBusyIds((prev) => ({ ...prev, [r.id]: true }));
    setRefunds((prev) => prev.filter((x) => x.id !== r.id));
    try {
      await settleRefund(r.id);
      toast(`Settled ${formatRupees(r.amount_cents)} refund`);
      load();
    } catch {
      toast('Settle failed', 'error');
      load();
    } finally {
      setBusyIds((prev) => {
        const next = { ...prev }; delete next[r.id]; return next;
      });
    }
  };

  const totalAmount = refunds.reduce((sum, r) => sum + Number(r.amount_cents || 0), 0);

  return (
    <div className="space-y-6">
      <Toaster toasts={toasts} />

      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-white">Refunds</h1>
          <p className="text-gray-400 text-sm mt-0.5">
            {total.toLocaleString()} {tab} ({formatRupees(totalAmount)} on this page)
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

      {/* Tabs */}
      <div className="flex border-b border-gray-800">
        {['pending', 'settled'].map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`px-4 py-2 text-sm font-medium capitalize transition-colors -mb-px border-b-2 ${
              tab === t
                ? 'text-indigo-400 border-indigo-500'
                : 'text-gray-500 border-transparent hover:text-gray-300'
            }`}
          >
            {t}
          </button>
        ))}
        <div className="ml-auto flex items-center gap-2 text-sm text-gray-400 pb-2">
          Page size
          <select
            value={limit}
            onChange={(e) => { setLimit(Number(e.target.value)); setPage(1); }}
            className="bg-gray-800 border border-gray-700 rounded px-2 py-1 text-gray-200"
          >
            {PAGE_SIZES.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
        </div>
      </div>

      <div className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-gray-800 text-xs text-gray-500 uppercase tracking-wide">
              <th className="text-left px-4 py-3 font-medium">ID</th>
              <th className="text-left px-4 py-3 font-medium">User Phone</th>
              <th className="text-right px-4 py-3 font-medium">Amount</th>
              <th className="text-left px-4 py-3 font-medium">Source</th>
              <th className="text-left px-4 py-3 font-medium">Source Ref</th>
              <th className="text-left px-4 py-3 font-medium">Created</th>
              {tab === 'settled' && (
                <th className="text-left px-4 py-3 font-medium">Settled</th>
              )}
              {tab === 'pending' && (
                <th className="text-right px-4 py-3 font-medium">Action</th>
              )}
            </tr>
          </thead>
          <tbody>
            {loading && refunds.length === 0 ? (
              <tr><td colSpan={8} className="text-center py-12 text-gray-500">Loading...</td></tr>
            ) : refunds.length === 0 ? (
              <tr><td colSpan={8} className="text-center py-12 text-gray-500">No {tab} refunds</td></tr>
            ) : (
              refunds.map((r) => {
                const busy = !!busyIds[r.id];
                return (
                  <tr key={r.id} className="border-b border-gray-800/50 hover:bg-gray-800/30 transition-colors">
                    <td className="px-4 py-3 text-gray-500 font-mono text-xs">{r.id.slice(0, 8)}…</td>
                    <td className="px-4 py-3 text-gray-300">{r.user_phone || <span className="text-gray-600">—</span>}</td>
                    <td className="px-4 py-3 text-right text-white font-medium">{formatRupees(r.amount_cents)}</td>
                    <td className="px-4 py-3 text-gray-300">{r.source}</td>
                    <td className="px-4 py-3 text-gray-400 font-mono text-xs">
                      {r.source_ref || <span className="text-gray-600">—</span>}
                    </td>
                    <td className="px-4 py-3 text-gray-400 text-xs">{formatDate(r.created_at)}</td>
                    {tab === 'settled' && (
                      <td className="px-4 py-3 text-gray-400 text-xs">{formatDate(r.settled_at)}</td>
                    )}
                    {tab === 'pending' && (
                      <td className="px-4 py-3">
                        <div className="flex justify-end">
                          <button
                            onClick={() => setConfirmSettle(r)}
                            disabled={busy}
                            className="flex items-center gap-1 px-3 py-1.5 bg-green-600/15 hover:bg-green-600/25 text-green-400 rounded-md text-xs font-medium transition-colors disabled:opacity-40"
                          >
                            <Check size={12} /> {busy ? 'Settling…' : 'Settle'}
                          </button>
                        </div>
                      </td>
                    )}
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
        open={!!confirmSettle}
        onClose={() => setConfirmSettle(null)}
        title="Mark as settled?"
      >
        <p className="text-sm text-gray-300">
          Mark refund of{' '}
          <span className="font-semibold text-white">
            {confirmSettle ? formatRupees(confirmSettle.amount_cents) : ''}
          </span>{' '}
          to{' '}
          <span className="font-semibold text-white">{confirmSettle?.user_phone || 'user'}</span>{' '}
          as settled? <span className="text-rose-300">Has the actual transfer happened?</span>{' '}
          This action is irreversible and is logged in the audit trail.
        </p>
        <div className="flex justify-end gap-2 mt-5">
          <button
            onClick={() => setConfirmSettle(null)}
            className="px-3 py-1.5 bg-gray-800 hover:bg-gray-700 text-gray-200 rounded-lg text-sm"
          >
            Cancel
          </button>
          <button
            onClick={handleSettle}
            className="px-3 py-1.5 bg-green-600 hover:bg-green-500 text-white rounded-lg text-sm font-medium"
          >
            Confirm Settled
          </button>
        </div>
      </Modal>
    </div>
  );
}
