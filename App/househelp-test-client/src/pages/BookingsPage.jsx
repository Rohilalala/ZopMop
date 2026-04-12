import { useState, useEffect, useCallback } from 'react';
import { RefreshCw, ChevronLeft, ChevronRight, XCircle, Search } from 'lucide-react';
import { getAdminBookings, cancelAdminBooking } from '../api/admin.api';
import StatusBadge from '../components/StatusBadge';
import { useToast } from '../hooks/useToast';
import Toaster from '../components/Toast';

const STATUSES = ['', 'pending', 'accepted', 'in_progress', 'completed', 'cancelled'];

function fmt(cents) {
  return '₹' + (cents / 100).toFixed(0);
}

function timeAgo(iso) {
  const diff = (Date.now() - new Date(iso)) / 1000;
  if (diff < 60) return `${Math.floor(diff)}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return new Date(iso).toLocaleDateString();
}

export default function BookingsPage() {
  const [bookings, setBookings] = useState([]);
  const [total, setTotal] = useState(0);
  const [totalPages, setTotalPages] = useState(1);
  const [page, setPage] = useState(1);
  const [status, setStatus] = useState('');
  const [search, setSearch] = useState('');
  const [searchInput, setSearchInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [cancelling, setCancelling] = useState(null);
  const { toasts, toast } = useToast();

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = { page, limit: 25 };
      if (status) params.status = status;
      if (search) params.search = search;
      const res = await getAdminBookings(params);
      setBookings(res.data || []);
      setTotal(res.total_count || 0);
      setTotalPages(res.total_pages || 1);
    } catch {
      toast('Failed to load bookings', 'error');
    } finally {
      setLoading(false);
    }
  }, [page, status, search]);

  useEffect(() => { load(); }, [load]);

  const handleStatusFilter = (s) => {
    setStatus(s);
    setPage(1);
  };

  const handleSearch = (e) => {
    e.preventDefault();
    setSearch(searchInput.trim());
    setPage(1);
  };

  const handleCancel = async (id) => {
    if (!window.confirm('Force-cancel this booking?')) return;
    setCancelling(id);
    try {
      await cancelAdminBooking(id);
      toast('Booking cancelled');
      load();
    } catch (err) {
      toast(err.response?.data?.error || 'Cancel failed', 'error');
    } finally {
      setCancelling(null);
    }
  };

  return (
    <div className="space-y-6">
      <Toaster toasts={toasts} />

      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-white">Bookings</h1>
          <p className="text-gray-400 text-sm mt-0.5">{total.toLocaleString()} total</p>
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

      {/* Filters */}
      <div className="flex flex-wrap gap-3 items-center">
        {/* Status tabs */}
        <div className="flex gap-1 bg-gray-800 rounded-lg p-1">
          {STATUSES.map((s) => (
            <button
              key={s || 'all'}
              onClick={() => handleStatusFilter(s)}
              className={`px-3 py-1.5 rounded-md text-xs font-medium transition-colors capitalize ${
                status === s
                  ? 'bg-indigo-600 text-white'
                  : 'text-gray-400 hover:text-white'
              }`}
            >
              {s || 'All'}
            </button>
          ))}
        </div>

        {/* Search */}
        <form onSubmit={handleSearch} className="flex gap-2 ml-auto">
          <input
            type="text"
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            placeholder="Customer phone or booking ID..."
            className="w-64 bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white placeholder-gray-500 focus:outline-none focus:border-indigo-500"
          />
          <button
            type="submit"
            className="px-3 py-2 bg-gray-800 hover:bg-gray-700 border border-gray-700 rounded-lg text-gray-300 transition-colors"
          >
            <Search size={14} />
          </button>
        </form>
      </div>

      {/* Table */}
      <div className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-gray-800 text-xs text-gray-500 uppercase tracking-wide">
              <th className="text-left px-4 py-3 font-medium">Booking</th>
              <th className="text-left px-4 py-3 font-medium">Customer</th>
              <th className="text-left px-4 py-3 font-medium">Helper</th>
              <th className="text-left px-4 py-3 font-medium">Service</th>
              <th className="text-left px-4 py-3 font-medium">Amount</th>
              <th className="text-left px-4 py-3 font-medium">Status</th>
              <th className="text-left px-4 py-3 font-medium">Created</th>
              <th className="px-4 py-3" />
            </tr>
          </thead>
          <tbody>
            {loading && bookings.length === 0 ? (
              <tr>
                <td colSpan={8} className="text-center py-12 text-gray-500">
                  Loading...
                </td>
              </tr>
            ) : bookings.length === 0 ? (
              <tr>
                <td colSpan={8} className="text-center py-12 text-gray-500">
                  No bookings found
                </td>
              </tr>
            ) : (
              bookings.map((b) => (
                <tr
                  key={b.id}
                  className="border-b border-gray-800/50 hover:bg-gray-800/30 transition-colors"
                >
                  <td className="px-4 py-3">
                    <span className="font-mono text-xs text-gray-400">{b.id.slice(0, 8)}…</span>
                  </td>
                  <td className="px-4 py-3 text-gray-200">{b.customer_phone}</td>
                  <td className="px-4 py-3 text-gray-400">
                    {b.helper_phone || <span className="text-gray-600">—</span>}
                  </td>
                  <td className="px-4 py-3 text-gray-300">{b.service_category}</td>
                  <td className="px-4 py-3">
                    <span className="text-white">{fmt(b.price_cents)}</span>
                    {b.discount_cents > 0 && (
                      <span className="ml-1 text-xs text-green-400">
                        -{fmt(b.discount_cents)}
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-3">
                    <StatusBadge status={b.status} />
                  </td>
                  <td className="px-4 py-3 text-gray-500 text-xs">{timeAgo(b.created_at)}</td>
                  <td className="px-4 py-3 text-right">
                    {b.status !== 'cancelled' && b.status !== 'completed' && (
                      <button
                        onClick={() => handleCancel(b.id)}
                        disabled={cancelling === b.id}
                        className="flex items-center gap-1 px-2 py-1 text-xs text-red-400 hover:text-red-300 hover:bg-red-500/10 rounded transition-colors disabled:opacity-50 ml-auto"
                      >
                        <XCircle size={12} />
                        Cancel
                      </button>
                    )}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {/* Pagination */}
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
