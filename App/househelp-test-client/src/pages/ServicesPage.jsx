import { useState, useEffect, useCallback } from 'react';
import { RefreshCw, Pencil, ToggleLeft, ToggleRight, Check, X, Plus, Trash2 } from 'lucide-react';
import { getAdminServices, updateService, createService, deleteService } from '../api/admin.api';
import { useToast } from '../hooks/useToast';
import Toaster from '../components/Toast';
import Modal, { Field } from '../components/Modal';

function fmt(cents) {
  return '₹' + (cents / 100).toFixed(0);
}

const CATEGORIES = [
  { value: 'home_cleaning', label: 'Home Cleaning' },
  { value: 'kitchen',       label: 'Kitchen Services' },
  { value: 'laundry',       label: 'Laundry & Fabric Care' },
  { value: 'outdoor',       label: 'Outdoor & Garden' },
  { value: 'vehicle',       label: 'Vehicle Care' },
  { value: 'pet',           label: 'Pet Care' },
  { value: 'other',         label: 'Other Services' },
];

function categoryLabel(val) {
  return CATEGORIES.find(c => c.value === val)?.label ?? val ?? '—';
}

const inputCls = 'bg-gray-700 border border-gray-600 rounded px-2 py-1 text-sm text-white focus:outline-none focus:border-indigo-500 w-full';
const selectCls = 'bg-gray-700 border border-gray-600 rounded px-2 py-1 text-sm text-white focus:outline-none focus:border-indigo-500 w-full';

function EditRow({ service, onSave, onCancel }) {
  const [name, setName]       = useState(service.name);
  const [emoji, setEmoji]     = useState(service.emoji || '');
  const [price, setPrice]     = useState((service.base_price_cents / 100).toFixed(0));
  const [order, setOrder]     = useState(service.display_order);
  const [category, setCategory] = useState(service.category || 'other');
  const [bgColor, setBgColor] = useState(service.bg_color || '#EEF2FF');
  const [saving, setSaving]   = useState(false);
  const { toast } = useToast();

  const save = async () => {
    if (!name.trim()) { toast('Name is required', 'error'); return; }
    const priceCents = Math.round(parseFloat(price) * 100);
    if (!priceCents || priceCents <= 0) { toast('Valid price is required', 'error'); return; }
    setSaving(true);
    try {
      await onSave({
        name: name.trim(),
        emoji: emoji || null,
        base_price_cents: priceCents,
        display_order: parseInt(order, 10) || 0,
        category,
        bg_color: bgColor || '#EEF2FF',
      });
    } catch (err) {
      toast(err.response?.data?.error || 'Save failed', 'error');
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <tr className="bg-indigo-950/40 border-b border-indigo-800/30">
        <td colSpan={8} className="px-3 py-1.5 text-xs text-indigo-300 font-medium">
          Editing: <span className="text-indigo-100">{service.name || '(unnamed)'}</span>
          <span className="ml-2 text-indigo-600 font-mono text-[10px]">id:{service.id}</span>
        </td>
      </tr>
    <tr className="border-b border-gray-800/50 bg-gray-800/40">
      <td className="px-3 py-2">
        <input value={emoji} onChange={e => setEmoji(e.target.value)} placeholder="emoji" className={inputCls} style={{ width: 56 }} />
      </td>
      <td className="px-3 py-2">
        <input value={name} onChange={e => setName(e.target.value)} className={inputCls} />
      </td>
      <td className="px-3 py-2">
        <select value={category} onChange={e => setCategory(e.target.value)} className={selectCls}>
          {CATEGORIES.map(c => <option key={c.value} value={c.value}>{c.label}</option>)}
        </select>
      </td>
      <td className="px-3 py-2">
        <input type="number" value={price} onChange={e => setPrice(e.target.value)} className={inputCls} style={{ width: 80 }} />
      </td>
      <td className="px-3 py-2">
        <input type="number" value={order} onChange={e => setOrder(e.target.value)} className={inputCls} style={{ width: 56 }} />
      </td>
      <td className="px-3 py-2">
        <input value={bgColor} onChange={e => setBgColor(e.target.value)} placeholder="#EEF2FF" className={inputCls} style={{ width: 90 }} />
      </td>
      <td className="px-3 py-2 text-gray-500">—</td>
      <td className="px-3 py-2 text-right">
        <div className="flex gap-2 justify-end">
          <button onClick={save} disabled={saving} className="flex items-center gap-1 px-2 py-1 text-xs bg-indigo-600 hover:bg-indigo-700 text-white rounded transition-colors disabled:opacity-50">
            <Check size={11} /> Save
          </button>
          <button onClick={onCancel} className="flex items-center gap-1 px-2 py-1 text-xs bg-gray-700 hover:bg-gray-600 text-gray-300 rounded transition-colors">
            <X size={11} /> Cancel
          </button>
        </div>
      </td>
    </tr>
    </>
  );
}

const EMPTY_FORM = { name: '', emoji: '', bg_color: '#EEF2FF', price: '', display_order: '', category: 'other', min_duration: '30', max_duration: '90', duration_step: '15' };

export default function ServicesPage() {
  const [services, setServices]   = useState([]);
  const [loading, setLoading]     = useState(false);
  const [editing, setEditing]     = useState(null);
  const [toggling, setToggling]   = useState(null);
  const [deleting, setDeleting]   = useState(null);
  const [creating, setCreating]   = useState(false);
  const [form, setForm]           = useState(EMPTY_FORM);
  const [saving, setSaving]       = useState(false);
  const { toasts, toast } = useToast();

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await getAdminServices();
      setServices(Array.isArray(res) ? res : (res.services || []));
    } catch {
      toast('Failed to load services', 'error');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const handleToggle = async (svc) => {
    if (toggling) return;
    setToggling(svc.id);
    try {
      await updateService(svc.id, { is_active: !svc.is_active });
      toast(`${svc.name} ${!svc.is_active ? 'activated' : 'deactivated'}`);
      setServices(prev => prev.map(s => s.id === svc.id ? { ...s, is_active: !s.is_active } : s));
    } catch (err) {
      toast(err.response?.data?.error || 'Toggle failed', 'error');
    } finally {
      setToggling(null);
    }
  };

  const handleSave = async (svc, payload) => {
    const updated = await updateService(svc.id, payload);
    toast(`${updated?.name ?? svc.name} updated`);
    setEditing(null);
    load();
  };

  const handleDelete = async (svc) => {
    if (!window.confirm(`Permanently delete "${svc.name}"? This cannot be undone.\n\nIf the service has existing bookings, use Deactivate instead.`)) return;
    setDeleting(svc.id);
    try {
      await deleteService(svc.id);
      toast(`${svc.name} deleted`);
      setServices(prev => prev.filter(s => s.id !== svc.id));
    } catch (err) {
      toast(err.response?.data?.error || 'Delete failed', 'error');
    } finally {
      setDeleting(null);
    }
  };

  const handleCreate = async () => {
    if (!form.name.trim()) { toast('Name is required', 'error'); return; }
    const priceCents = Math.round(parseFloat(form.price) * 100);
    if (!priceCents || priceCents <= 0) { toast('Valid price required', 'error'); return; }
    setSaving(true);
    try {
      const payload = {
        name: form.name.trim(),
        emoji: form.emoji || undefined,
        bg_color: form.bg_color || '#EEF2FF',
        base_price_cents: priceCents,
        display_order: parseInt(form.display_order, 10) || 0,
        category: form.category || 'other',
        min_duration_minutes: parseInt(form.min_duration, 10) || 30,
        max_duration_minutes: parseInt(form.max_duration, 10) || 90,
        duration_step_minutes: parseInt(form.duration_step, 10) || 15,
      };
      await createService(payload);
      toast('Service created');
      setCreating(false);
      setForm(EMPTY_FORM);
      load();
    } catch (err) {
      toast(err.response?.data?.error || 'Create failed', 'error');
    } finally {
      setSaving(false);
    }
  };

  // Stable sort: primary = display_order, secondary = name (prevents tie randomness).
  const sorted = [...services].sort(
    (a, b) => a.display_order - b.display_order || a.name.localeCompare(b.name)
  );

  return (
    <div className="space-y-6">
      <Toaster toasts={toasts} />

      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-white">Services</h1>
          <p className="text-gray-400 text-sm mt-0.5">{services.length} service categories</p>
        </div>
        <div className="flex gap-2">
          <button onClick={load} disabled={loading} className="flex items-center gap-2 px-3 py-2 bg-gray-800 hover:bg-gray-700 text-gray-300 rounded-lg text-sm transition-colors disabled:opacity-50">
            <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
            Refresh
          </button>
          <button onClick={() => { setForm(EMPTY_FORM); setCreating(true); }} className="flex items-center gap-2 px-3 py-2 bg-indigo-600 hover:bg-indigo-700 text-white rounded-lg text-sm transition-colors">
            <Plus size={14} /> New Service
          </button>
        </div>
      </div>

      <div className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-gray-800 text-xs text-gray-500 uppercase tracking-wide">
              <th className="text-left px-3 py-3 font-medium w-12">Icon</th>
              <th className="text-left px-3 py-3 font-medium">Name</th>
              <th className="text-left px-3 py-3 font-medium">Category</th>
              <th className="text-left px-3 py-3 font-medium">Base Price</th>
              <th className="text-left px-3 py-3 font-medium">Order</th>
              <th className="text-left px-3 py-3 font-medium">BG</th>
              <th className="text-left px-3 py-3 font-medium">Active</th>
              <th className="px-3 py-3" />
            </tr>
          </thead>
          <tbody>
            {loading && sorted.length === 0 ? (
              <tr><td colSpan={8} className="text-center py-12 text-gray-500">Loading...</td></tr>
            ) : sorted.length === 0 ? (
              <tr><td colSpan={8} className="text-center py-12 text-gray-500">No services</td></tr>
            ) : (
              sorted.map(svc =>
                editing === svc.id ? (
                  <EditRow
                    key={svc.id}
                    service={svc}
                    onSave={payload => handleSave(svc, payload)}
                    onCancel={() => setEditing(null)}
                  />
                ) : (
                  <tr key={svc.id} className="border-b border-gray-800/50 hover:bg-gray-800/30 transition-colors">
                    <td className="px-3 py-3">
                      <div className="w-8 h-8 rounded-lg flex items-center justify-center text-base" style={{ backgroundColor: svc.bg_color || '#374151' }}>
                        {svc.emoji || '?'}
                      </div>
                    </td>
                    <td className="px-3 py-3 text-white font-medium">{svc.name}</td>
                    <td className="px-3 py-3">
                      <span className="text-xs px-2 py-0.5 rounded-full bg-gray-800 text-gray-300 border border-gray-700">
                        {categoryLabel(svc.category)}
                      </span>
                    </td>
                    <td className="px-3 py-3 text-gray-300">{fmt(svc.base_price_cents)}</td>
                    <td className="px-3 py-3 text-gray-400">{svc.display_order}</td>
                    <td className="px-3 py-3">
                      <span className="text-xs font-mono text-gray-500">{svc.bg_color || '—'}</span>
                    </td>
                    <td className="px-3 py-3">
                      <button
                        onClick={() => handleToggle(svc)}
                        disabled={toggling === svc.id}
                        className={`transition-colors disabled:opacity-50 ${svc.is_active ? 'text-green-400 hover:text-green-300' : 'text-gray-600 hover:text-gray-400'}`}
                        title={svc.is_active ? 'Active — click to deactivate' : 'Inactive — click to activate'}
                      >
                        {svc.is_active ? <ToggleRight size={22} /> : <ToggleLeft size={22} />}
                      </button>
                    </td>
                    <td className="px-3 py-3 text-right">
                      <div className="flex gap-1 justify-end">
                        <button onClick={() => setEditing(svc.id)} className="flex items-center gap-1 px-2 py-1 text-xs text-gray-400 hover:text-white hover:bg-gray-700 rounded transition-colors">
                          <Pencil size={11} /> Edit
                        </button>
                        <button
                          onClick={() => handleDelete(svc)}
                          disabled={deleting === svc.id}
                          className="flex items-center gap-1 px-2 py-1 text-xs text-red-500 hover:text-red-400 hover:bg-red-900/20 rounded transition-colors disabled:opacity-50"
                        >
                          <Trash2 size={11} /> Delete
                        </button>
                      </div>
                    </td>
                  </tr>
                )
              )
            )}
          </tbody>
        </table>
      </div>

      {/* Create modal */}
      <Modal isOpen={creating} onClose={() => setCreating(false)} title="New Service">
        <div className="grid grid-cols-2 gap-4">
          <Field label="Name *" className="col-span-2">
            <input value={form.name} onChange={e => setForm(p => ({ ...p, name: e.target.value }))} placeholder="e.g. Deep Cleaning" className={inputCls} />
          </Field>
          <Field label="Emoji">
            <input value={form.emoji} onChange={e => setForm(p => ({ ...p, emoji: e.target.value }))} placeholder="🧹" className={inputCls} />
          </Field>
          <Field label="Category *">
            <select value={form.category} onChange={e => setForm(p => ({ ...p, category: e.target.value }))} className={selectCls}>
              {CATEGORIES.map(c => <option key={c.value} value={c.value}>{c.label}</option>)}
            </select>
          </Field>
          <Field label="Base Price (₹) *">
            <input type="number" value={form.price} onChange={e => setForm(p => ({ ...p, price: e.target.value }))} placeholder="250" className={inputCls} />
          </Field>
          <Field label="Display Order">
            <input type="number" value={form.display_order} onChange={e => setForm(p => ({ ...p, display_order: e.target.value }))} placeholder="0" className={inputCls} />
          </Field>
          <Field label="BG Color">
            <input value={form.bg_color} onChange={e => setForm(p => ({ ...p, bg_color: e.target.value }))} placeholder="#EEF2FF" className={inputCls} />
          </Field>
          <Field label="Min Duration (min)">
            <input type="number" value={form.min_duration} onChange={e => setForm(p => ({ ...p, min_duration: e.target.value }))} className={inputCls} />
          </Field>
          <Field label="Max Duration (min)">
            <input type="number" value={form.max_duration} onChange={e => setForm(p => ({ ...p, max_duration: e.target.value }))} className={inputCls} />
          </Field>
          <Field label="Duration Step (min)" className="col-span-2">
            <input type="number" value={form.duration_step} onChange={e => setForm(p => ({ ...p, duration_step: e.target.value }))} className={inputCls} />
          </Field>
        </div>
        <div className="flex justify-end gap-3 mt-6">
          <button onClick={() => setCreating(false)} className="px-4 py-2 text-sm bg-gray-700 hover:bg-gray-600 text-gray-300 rounded-lg transition-colors">
            Cancel
          </button>
          <button onClick={handleCreate} disabled={saving} className="px-4 py-2 text-sm bg-indigo-600 hover:bg-indigo-700 text-white rounded-lg transition-colors disabled:opacity-50">
            {saving ? 'Creating…' : 'Create Service'}
          </button>
        </div>
      </Modal>
    </div>
  );
}