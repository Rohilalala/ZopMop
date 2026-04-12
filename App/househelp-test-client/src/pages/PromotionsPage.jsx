import { useState, useEffect } from 'react';
import { RefreshCw, Plus, XCircle } from 'lucide-react';
import { getPromotions, createPromotion, disablePromotion } from '../api/admin.api';
import { useToast } from '../hooks/useToast';
import Toaster from '../components/Toast';
import Modal, { Field } from '../components/Modal';

function fmtDiscount(p) {
  return p.discount_type === 'percent' ? `${p.discount_value}%` : `₹${(p.discount_value / 100).toFixed(0)}`;
}

function fmtDate(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString();
}

const EMPTY_FORM = { code: '', discount_type: 'percent', discount_value: '', min_order_cents: '', max_uses: '0', expires_days: '30' };

export default function PromotionsPage() {
  const [promotions, setPromotions] = useState([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [disabling, setDisabling] = useState(null);
  const [showCreate, setShowCreate] = useState(false);
  const [form, setForm] = useState(EMPTY_FORM);
  const [creating, setCreating] = useState(false);
  const { toasts, toast } = useToast();

  const load = async () => {
    setLoading(true);
    try {
      const res = await getPromotions({ limit: 50 });
      setPromotions(res.data || res.promotions || []);
      setTotal(res.total_count || 0);
    } catch {
      toast('Failed to load promotions', 'error');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);

  const f = (key) => (e) => setForm((prev) => ({ ...prev, [key]: e.target.value }));

  const handleCreate = async () => {
    if (!form.code || !form.discount_value) {
      toast('Code and discount value required', 'error');
      return;
    }
    setCreating(true);
    try {
      const expiresAt = new Date(Date.now() + parseInt(form.expires_days) * 86400000).toISOString();
      const payload = {
        code: form.code.toUpperCase().trim(),
        discount_type: form.discount_type,
        discount_value: parseInt(form.discount_value),
        min_order_cents: parseInt(form.min_order_cents) || 0,
        expires_at: expiresAt,
      };
      if (parseInt(form.max_uses) > 0) payload.max_uses = parseInt(form.max_uses);
      await createPromotion(payload);
      toast(`${payload.code} created`);
      setShowCreate(false);
      setForm(EMPTY_FORM);
      load();
    } catch (err) {
      toast(err.response?.data?.error || 'Create failed', 'error');
    } finally {
      setCreating(false);
    }
  };

  const handleDisable = async (promo) => {
    if (!window.confirm(`Disable promo code "${promo.code}"?`)) return;
    setDisabling(promo.id);
    try {
      await disablePromotion(promo.id);
      toast(`${promo.code} disabled`);
      setPromotions((prev) => prev.map((p) => p.id === promo.id ? { ...p, is_active: false } : p));
    } catch (err) {
      toast(err.response?.data?.error || 'Disable failed', 'error');
    } finally {
      setDisabling(null);
    }
  };

  const active = promotions.filter((p) => p.is_active);
  const inactive = promotions.filter((p) => !p.is_active);

  return (
    <div className="space-y-6">
      <Toaster toasts={toasts} />

      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-white">Promotions</h1>
          <p className="text-gray-400 text-sm mt-0.5">{total || promotions.length} codes</p>
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
            onClick={() => setShowCreate(true)}
            className="flex items-center gap-2 px-3 py-2 bg-indigo-600 hover:bg-indigo-700 text-white rounded-lg text-sm transition-colors"
          >
            <Plus size={14} /> New Promo
          </button>
        </div>
      </div>

      {/* Active promos */}
      <div className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden">
        <div className="px-4 py-3 border-b border-gray-800">
          <h2 className="text-sm font-semibold text-white">Active ({active.length})</h2>
        </div>
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-gray-800 text-xs text-gray-500 uppercase tracking-wide">
              <th className="text-left px-4 py-3 font-medium">Code</th>
              <th className="text-left px-4 py-3 font-medium">Discount</th>
              <th className="text-left px-4 py-3 font-medium">Min Order</th>
              <th className="text-left px-4 py-3 font-medium">Uses</th>
              <th className="text-left px-4 py-3 font-medium">Expires</th>
              <th className="px-4 py-3" />
            </tr>
          </thead>
          <tbody>
            {loading && active.length === 0 ? (
              <tr><td colSpan={6} className="text-center py-8 text-gray-500">Loading...</td></tr>
            ) : active.length === 0 ? (
              <tr><td colSpan={6} className="text-center py-8 text-gray-500">No active promotions</td></tr>
            ) : (
              active.map((p) => (
                <tr key={p.id} className="border-b border-gray-800/50 hover:bg-gray-800/30 transition-colors">
                  <td className="px-4 py-3 font-mono font-bold text-green-400">{p.code}</td>
                  <td className="px-4 py-3 text-white">{fmtDiscount(p)}</td>
                  <td className="px-4 py-3 text-gray-400">₹{(p.min_order_cents / 100).toFixed(0)}</td>
                  <td className="px-4 py-3 text-gray-300">
                    {p.uses_count} / {p.max_uses === 0 ? '∞' : p.max_uses}
                  </td>
                  <td className="px-4 py-3 text-gray-400 text-xs">{fmtDate(p.expires_at)}</td>
                  <td className="px-4 py-3 text-right">
                    <button
                      onClick={() => handleDisable(p)}
                      disabled={disabling === p.id}
                      className="flex items-center gap-1 px-2 py-1 text-xs text-red-400 hover:text-red-300 hover:bg-red-500/10 rounded transition-colors disabled:opacity-50 ml-auto"
                    >
                      <XCircle size={12} /> Disable
                    </button>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {/* Inactive promos */}
      {inactive.length > 0 && (
        <div className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden">
          <div className="px-4 py-3 border-b border-gray-800">
            <h2 className="text-sm font-semibold text-gray-500">Disabled ({inactive.length})</h2>
          </div>
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-800 text-xs text-gray-500 uppercase tracking-wide">
                <th className="text-left px-4 py-3 font-medium">Code</th>
                <th className="text-left px-4 py-3 font-medium">Discount</th>
                <th className="text-left px-4 py-3 font-medium">Uses</th>
                <th className="text-left px-4 py-3 font-medium">Expired</th>
              </tr>
            </thead>
            <tbody>
              {inactive.map((p) => (
                <tr key={p.id} className="border-b border-gray-800/50 opacity-50">
                  <td className="px-4 py-3 font-mono text-gray-400">{p.code}</td>
                  <td className="px-4 py-3 text-gray-400">{fmtDiscount(p)}</td>
                  <td className="px-4 py-3 text-gray-500">{p.uses_count} / {p.max_uses === 0 ? '∞' : p.max_uses}</td>
                  <td className="px-4 py-3 text-gray-500 text-xs">{fmtDate(p.expires_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Create modal */}
      <Modal
        isOpen={showCreate}
        onClose={() => { setShowCreate(false); setForm(EMPTY_FORM); }}
        title="New Promotion"
      >
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <Field label="Code">
              <input
                type="text"
                value={form.code}
                onChange={f('code')}
                placeholder="SAVE20"
                className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white font-mono uppercase placeholder-gray-600 focus:outline-none focus:border-indigo-500"
              />
            </Field>
            <Field label="Discount Type">
              <select value={form.discount_type} onChange={f('discount_type')} className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-indigo-500">
                <option value="percent">Percent (%)</option>
                <option value="fixed">Fixed (₹)</option>
              </select>
            </Field>
            <Field label={form.discount_type === 'percent' ? 'Discount %' : 'Discount ₹'}>
              <input type="number" value={form.discount_value} onChange={f('discount_value')} className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-indigo-500" />
            </Field>
            <Field label="Min Order (₹)">
              <input type="number" value={form.min_order_cents} onChange={f('min_order_cents')} placeholder="0" className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-indigo-500" />
            </Field>
            <Field label="Max Uses (0 = unlimited)">
              <input type="number" value={form.max_uses} onChange={f('max_uses')} className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-indigo-500" />
            </Field>
            <Field label="Expires In (days)">
              <input type="number" value={form.expires_days} onChange={f('expires_days')} className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-indigo-500" />
            </Field>
          </div>

          <div className="flex justify-end gap-3 pt-2">
            <button onClick={() => { setShowCreate(false); setForm(EMPTY_FORM); }} className="px-4 py-2 text-sm text-gray-400 hover:text-white bg-gray-800 hover:bg-gray-700 rounded-lg transition-colors">
              Cancel
            </button>
            <button onClick={handleCreate} disabled={creating} className="px-4 py-2 text-sm bg-indigo-600 hover:bg-indigo-700 text-white rounded-lg transition-colors disabled:opacity-50">
              {creating ? 'Creating...' : 'Create Promo'}
            </button>
          </div>
        </div>
      </Modal>
    </div>
  );
}
