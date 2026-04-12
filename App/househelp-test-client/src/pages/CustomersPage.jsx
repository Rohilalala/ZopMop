import { useState, useEffect, useCallback } from 'react';
import { RefreshCw, ChevronLeft, ChevronRight, Search, ShieldOff, ShieldCheck } from 'lucide-react';
import { getUsers, suspendUser, unsuspendUser } from '../api/admin.api';
import StatusBadge from '../components/StatusBadge';
import { useToast } from '../hooks/useToast';
import Toaster from '../components/Toast';

const ROLES = ['', 'customer', 'pro', 'admin'];

export default function CustomersPage() {
  const [users, setUsers] = useState([]);
  const [total, setTotal] = useState(0);
  const [totalPages, setTotalPages] = useState(1);
  const [page, setPage] = useState(1);
  const [role, setRole] = useState('customer');
  const [searchInput, setSearchInput] = useState('');
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(false);
  const [actioning, setActioning] = useState(null);
  const { toasts, toast } = useToast();

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = { page, limit: 25 };
      if (role) params.role = role;
      if (search) params.search = search;
      const res = await getUsers(params);
      setUsers(res.data || res.users || []);
      setTotal(res.total_count || 0);
      setTotalPages(res.total_pages || 1);
    } catch {
      toast('Failed to load users', 'error');
    } finally {
      setLoading(false);
    }
  }, [page, role, search]);

  useEffect(() => { load(); }, [load]);

  const handleSearch = (e) => {
    e.preventDefault();
    setSearch(searchInput.trim());
    setPage(1);
  };

  const handleSuspend = async (user) => {
    const action = user.is_suspended ? 'unsuspend' : 'suspend';
    if (!window.confirm(`${action.charAt(0).toUpperCase() + action.slice(1)} ${user.phone}?`)) return;
    setActioning(user.id);
    try {
      if (user.is_suspended) {
        await unsuspendUser(user.id);
        toast(`${user.phone} unsuspended`);
      } else {
        await suspendUser(user.id);
        toast(`${user.phone} suspended`, 'error');
      }
      load();
    } catch (err) {
      toast(err.response?.data?.error || 'Action failed', 'error');
    } finally {
      setActioning(null);
    }
  };

  return (
    <div className="space-y-6">
      <Toaster toasts={toasts} />

      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-white">Customers</h1>
          <p className="text-gray-400 text-sm mt-0.5">{total.toLocaleString()} users</p>
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
        <div className="flex gap-1 bg-gray-800 rounded-lg p-1">
          {ROLES.map((r) => (
            <button
              key={r || 'all'}
              onClick={() => { setRole(r); setPage(1); }}
              className={`px-3 py-1.5 rounded-md text-xs font-medium transition-colors capitalize ${
                role === r ? 'bg-indigo-600 text-white' : 'text-gray-400 hover:text-white'
              }`}
            >
              {r || 'All'}
            </button>
          ))}
        </div>

        <form onSubmit={handleSearch} className="flex gap-2 ml-auto">
          <input
            type="text"
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            placeholder="Search phone or name..."
            className="w-60 bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white placeholder-gray-500 focus:outline-none focus:border-indigo-500"
          />
          <button type="submit" className="px-3 py-2 bg-gray-800 hover:bg-gray-700 border border-gray-700 rounded-lg text-gray-300 transition-colors">
            <Search size={14} />
          </button>
        </form>
      </div>

      {/* Table */}
      <div className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-gray-800 text-xs text-gray-500 uppercase tracking-wide">
              <th className="text-left px-4 py-3 font-medium">Name</th>
              <th className="text-left px-4 py-3 font-medium">Phone</th>
              <th className="text-left px-4 py-3 font-medium">Role</th>
              <th className="text-left px-4 py-3 font-medium">Status</th>
              <th className="text-left px-4 py-3 font-medium">Joined</th>
              <th className="px-4 py-3" />
            </tr>
          </thead>
          <tbody>
            {loading && users.length === 0 ? (
              <tr><td colSpan={6} className="text-center py-12 text-gray-500">Loading...</td></tr>
            ) : users.length === 0 ? (
              <tr><td colSpan={6} className="text-center py-12 text-gray-500">No users found</td></tr>
            ) : (
              users.map((u) => (
                <tr key={u.id} className="border-b border-gray-800/50 hover:bg-gray-800/30 transition-colors">
                  <td className="px-4 py-3 text-white font-medium">{u.name || <span className="text-gray-600">—</span>}</td>
                  <td className="px-4 py-3 text-gray-300">{u.phone}</td>
                  <td className="px-4 py-3">
                    <span className={`px-2 py-0.5 rounded text-xs font-medium ${
                      u.role === 'admin' ? 'bg-purple-500/20 text-purple-300' :
                      u.role === 'pro' ? 'bg-blue-500/20 text-blue-300' :
                      'bg-gray-700 text-gray-300'
                    }`}>
                      {u.role}
                    </span>
                  </td>
                  <td className="px-4 py-3">
                    <StatusBadge status={u.is_suspended ? 'suspended' : 'active'} />
                  </td>
                  <td className="px-4 py-3 text-gray-500 text-xs">
                    {new Date(u.created_at).toLocaleDateString()}
                  </td>
                  <td className="px-4 py-3 text-right">
                    <button
                      onClick={() => handleSuspend(u)}
                      disabled={actioning === u.id}
                      className={`flex items-center gap-1 px-2 py-1 text-xs rounded transition-colors disabled:opacity-50 ml-auto ${
                        u.is_suspended
                          ? 'text-green-400 hover:text-green-300 hover:bg-green-500/10'
                          : 'text-red-400 hover:text-red-300 hover:bg-red-500/10'
                      }`}
                    >
                      {u.is_suspended
                        ? <><ShieldCheck size={12} /> Unsuspend</>
                        : <><ShieldOff size={12} /> Suspend</>
                      }
                    </button>
                  </td>
                </tr>
              ))
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
