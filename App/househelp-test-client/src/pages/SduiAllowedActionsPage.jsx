import { useState, useEffect, useCallback } from 'react';
import { RefreshCw, Plus, Trash2 } from 'lucide-react';
import {
  listAllowedActions, addAllowedAction, deleteAllowedAction,
} from '../api/sdui.api';
import { useToast } from '../hooks/useToast';
import Toaster from '../components/Toast';
import Modal, { Field } from '../components/Modal';

const METHODS = ['POST', 'DELETE', 'PUT', 'PATCH'];

const METHOD_STYLES = {
  POST:   'bg-blue-500/15  text-blue-300   border-blue-700/40',
  DELETE: 'bg-red-500/15   text-red-300    border-red-700/40',
  PUT:    'bg-yellow-500/15 text-yellow-300 border-yellow-700/40',
  PATCH:  'bg-purple-500/15 text-purple-300 border-purple-700/40',
  GET:    'bg-gray-500/15   text-gray-300   border-gray-700/40',
};

function fmtDate(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  return d.toLocaleDateString() + ' ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

const EMPTY_FORM = { endpoint: '', methods: ['POST'] };

export default function SduiAllowedActionsPage() {
  const [actions, setActions] = useState([]);
  const [loading, setLoading] = useState(false);
  const [showAdd, setShowAdd] = useState(false);
  const [form, setForm] = useState(EMPTY_FORM);
  const [saving, setSaving] = useState(false);
  const [deletingId, setDeletingId] = useState(null);
  const { toasts, toast } = useToast();

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await listAllowedActions();
      setActions(res?.actions || []);
    } catch {
      toast('Failed to load allowed actions', 'error');
    } finally {
      setLoading(false);
    }
  }, [toast]);

  useEffect(() => { load(); }, [load]);

  const toggleMethod = (m) => {
    setForm((s) => ({
      ...s,
      methods: s.methods.includes(m) ? s.methods.filter((x) => x !== m) : [...s.methods, m],
    }));
  };

  const handleAdd = async () => {
    if (!form.endpoint.trim()) return toast('Endpoint required', 'error');
    if (form.methods.length === 0) return toast('Pick at least one method', 'error');
    setSaving(true);
    try {
      await addAllowedAction({ endpoint: form.endpoint.trim(), methods: form.methods });
      toast('Added');
      setShowAdd(false);
      setForm(EMPTY_FORM);
      load();
    } catch (err) {
      toast(err.response?.data?.error || 'Add failed', 'error');
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (a) => {
    if (!window.confirm(`Delete allowed action "${a.endpoint}"?`)) return;
    setDeletingId(a.id);
    try {
      await deleteAllowedAction(a.id);
      toast('Deleted');
      setActions((prev) => prev.filter((x) => x.id !== a.id));
    } catch (err) {
      toast(err.response?.data?.error || 'Delete failed', 'error');
    } finally {
      setDeletingId(null);
    }
  };

  return (
    <div className="space-y-6">
      <Toaster toasts={toasts} />

      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-white">SDUI Allowed Actions</h1>
          <p className="text-gray-400 text-sm mt-0.5">
            Whitelist of (endpoint, method) pairs SDUI buttons may call. {actions.length} entries.
          </p>
        </div>
        <div className="flex gap-2">
          <button
            onClick={load}
            disabled={loading}
            className="flex items-center gap-2 px-3 py-2 bg-gray-800 hover:bg-gray-700 text-gray-300 rounded-lg text-sm transition-colors disabled:opacity-50"
          >
            <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
          </button>
          <button
            onClick={() => setShowAdd(true)}
            className="flex items-center gap-2 px-3 py-2 bg-indigo-600 hover:bg-indigo-700 text-white rounded-lg text-sm transition-colors"
          >
            <Plus size={14} /> Add action
          </button>
        </div>
      </div>

      <div className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-gray-800 text-xs text-gray-500 uppercase tracking-wide">
              <th className="text-left px-4 py-3 font-medium">Endpoint</th>
              <th className="text-left px-4 py-3 font-medium">Methods</th>
              <th className="text-left px-4 py-3 font-medium">Active</th>
              <th className="text-left px-4 py-3 font-medium">Created by</th>
              <th className="text-left px-4 py-3 font-medium">Created at</th>
              <th className="px-4 py-3" />
            </tr>
          </thead>
          <tbody>
            {loading && actions.length === 0 ? (
              <tr><td colSpan={6} className="text-center py-8 text-gray-500">Loading...</td></tr>
            ) : actions.length === 0 ? (
              <tr><td colSpan={6} className="text-center py-8 text-gray-500">No allowed actions</td></tr>
            ) : (
              actions.map((a) => (
                <tr key={a.id} className="border-b border-gray-800/50 hover:bg-gray-800/30 transition-colors">
                  <td className="px-4 py-3 font-mono text-indigo-300 truncate max-w-[400px]">{a.endpoint}</td>
                  <td className="px-4 py-3">
                    <div className="flex flex-wrap gap-1">
                      {(a.methods || []).map((m) => (
                        <span
                          key={m}
                          className={`inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-mono font-semibold border ${METHOD_STYLES[m] || METHOD_STYLES.GET}`}
                        >
                          {m}
                        </span>
                      ))}
                    </div>
                  </td>
                  <td className="px-4 py-3">
                    <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium border ${
                      a.is_active ? 'bg-green-500/15 text-green-400 border-green-700/40' : 'bg-gray-500/15 text-gray-400 border-gray-700/40'
                    }`}>
                      {a.is_active ? 'active' : 'inactive'}
                    </span>
                  </td>
                  <td className="px-4 py-3 font-mono text-[10px] text-gray-500">{a.created_by ? `${a.created_by.slice(0, 8)}…` : '—'}</td>
                  <td className="px-4 py-3 text-xs text-gray-500 whitespace-nowrap">{fmtDate(a.created_at)}</td>
                  <td className="px-4 py-3 text-right">
                    <button
                      onClick={() => handleDelete(a)}
                      disabled={deletingId === a.id}
                      className="flex items-center gap-1 px-2 py-1 text-xs text-red-400 hover:text-red-300 hover:bg-red-500/10 rounded transition-colors disabled:opacity-50 ml-auto"
                    >
                      <Trash2 size={12} /> Delete
                    </button>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      <Modal
        isOpen={showAdd}
        onClose={() => { setShowAdd(false); setForm(EMPTY_FORM); }}
        title="Add allowed action"
      >
        <div className="space-y-4">
          <Field label="Endpoint" hint="Path or path prefix (e.g. /api/v1/bookings).">
            <input
              type="text"
              value={form.endpoint}
              onChange={(e) => setForm((s) => ({ ...s, endpoint: e.target.value }))}
              placeholder="/api/v1/bookings"
              className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white font-mono placeholder-gray-600 focus:outline-none focus:border-indigo-500"
            />
          </Field>
          <Field label="Methods">
            <div className="flex flex-wrap gap-2">
              {METHODS.map((m) => {
                const active = form.methods.includes(m);
                return (
                  <button
                    type="button"
                    key={m}
                    onClick={() => toggleMethod(m)}
                    className={`px-3 py-1.5 rounded-lg text-xs font-mono font-semibold border transition-colors ${
                      active
                        ? `${METHOD_STYLES[m]} ring-1 ring-indigo-500/30`
                        : 'bg-gray-800 text-gray-500 border-gray-700 hover:text-gray-300'
                    }`}
                  >
                    {m}
                  </button>
                );
              })}
            </div>
          </Field>

          <div className="flex justify-end gap-3 pt-2">
            <button onClick={() => { setShowAdd(false); setForm(EMPTY_FORM); }} className="px-4 py-2 text-sm text-gray-400 hover:text-white bg-gray-800 hover:bg-gray-700 rounded-lg transition-colors">
              Cancel
            </button>
            <button onClick={handleAdd} disabled={saving} className="px-4 py-2 text-sm bg-indigo-600 hover:bg-indigo-700 text-white rounded-lg transition-colors disabled:opacity-50">
              {saving ? 'Adding...' : 'Add action'}
            </button>
          </div>
        </div>
      </Modal>
    </div>
  );
}
