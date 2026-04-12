import { useState, useEffect } from 'react';
import { RefreshCw, Plus, Trash2, Pencil, Check, X } from 'lucide-react';
import { getBanners, createBanner, updateBanner, deleteBanner, getScreens, updateScreen } from '../api/admin.api';
import { useToast } from '../hooks/useToast';
import Toaster from '../components/Toast';
import Modal, { Field } from '../components/Modal';

const TABS = ['Banners', 'Screens'];

const EMPTY_BANNER = { title: '', subtitle: '', image_url: '', tap_action: '', display_order: '1', is_active: true };

// ── Banner tab ──────────────────────────────────────────────────────────────
function BannersTab() {
  const [banners, setBanners] = useState([]);
  const [loading, setLoading] = useState(false);
  const [showCreate, setShowCreate] = useState(false);
  const [form, setForm] = useState(EMPTY_BANNER);
  const [creating, setCreating] = useState(false);
  const [deleting, setDeleting] = useState(null);
  const { toasts, toast } = useToast();

  const load = async () => {
    setLoading(true);
    try {
      const res = await getBanners();
      setBanners(Array.isArray(res) ? res : (res.banners || []));
    } catch { toast('Failed to load banners', 'error'); }
    finally { setLoading(false); }
  };

  useEffect(() => { load(); }, []);

  const f = (key) => (e) => setForm((p) => ({ ...p, [key]: e.target.type === 'checkbox' ? e.target.checked : e.target.value }));

  const handleCreate = async () => {
    if (!form.title || !form.image_url) { toast('Title and image URL required', 'error'); return; }
    setCreating(true);
    try {
      await createBanner({
        title: form.title,
        subtitle: form.subtitle,
        image_url: form.image_url,
        tap_action: form.tap_action,
        display_order: parseInt(form.display_order) || 1,
        is_active: form.is_active,
        starts_at: new Date().toISOString(),
        ends_at: new Date(Date.now() + 86400000 * 30).toISOString(),
      });
      toast('Banner created');
      setShowCreate(false);
      setForm(EMPTY_BANNER);
      load();
    } catch (err) { toast(err.response?.data?.error || 'Create failed', 'error'); }
    finally { setCreating(false); }
  };

  const handleDelete = async (banner) => {
    if (!window.confirm(`Delete banner "${banner.title}"?`)) return;
    setDeleting(banner.id);
    try {
      await deleteBanner(banner.id);
      toast('Banner deleted');
      setBanners((prev) => prev.filter((b) => b.id !== banner.id));
    } catch (err) { toast(err.response?.data?.error || 'Delete failed', 'error'); }
    finally { setDeleting(null); }
  };

  const handleToggle = async (banner) => {
    try {
      await updateBanner(banner.id, { is_active: !banner.is_active });
      toast(`Banner ${!banner.is_active ? 'activated' : 'deactivated'}`);
      setBanners((prev) => prev.map((b) => b.id === banner.id ? { ...b, is_active: !b.is_active } : b));
    } catch (err) { toast(err.response?.data?.error || 'Update failed', 'error'); }
  };

  return (
    <div className="space-y-4">
      <Toaster toasts={toasts} />
      <div className="flex justify-between items-center">
        <p className="text-sm text-gray-400">{banners.length} banners</p>
        <div className="flex gap-2">
          <button onClick={load} disabled={loading} className="p-2 bg-gray-800 hover:bg-gray-700 text-gray-400 rounded-lg transition-colors disabled:opacity-50">
            <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
          </button>
          <button onClick={() => setShowCreate(true)} className="flex items-center gap-2 px-3 py-2 bg-indigo-600 hover:bg-indigo-700 text-white rounded-lg text-sm transition-colors">
            <Plus size={14} /> New Banner
          </button>
        </div>
      </div>

      <div className="space-y-3">
        {loading && banners.length === 0 ? (
          <div className="text-center py-8 text-gray-500">Loading...</div>
        ) : banners.length === 0 ? (
          <div className="text-center py-8 text-gray-500">No banners</div>
        ) : (
          banners
            .sort((a, b) => a.display_order - b.display_order)
            .map((banner) => (
              <div key={banner.id} className={`flex items-center gap-4 p-4 bg-gray-900 border rounded-xl transition-colors ${banner.is_active ? 'border-gray-800' : 'border-gray-800 opacity-50'}`}>
                {banner.image_url && (
                  <img src={banner.image_url} alt="" className="w-16 h-10 object-cover rounded-lg shrink-0 bg-gray-700" onError={(e) => { e.target.style.display = 'none'; }} />
                )}
                <div className="flex-1 min-w-0">
                  <p className="text-white font-medium truncate">{banner.title}</p>
                  {banner.subtitle && <p className="text-gray-400 text-xs truncate">{banner.subtitle}</p>}
                  {banner.tap_action && <p className="text-indigo-400 text-xs truncate">→ {banner.tap_action}</p>}
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <span className="text-xs text-gray-500">#{banner.display_order}</span>
                  <button
                    onClick={() => handleToggle(banner)}
                    className={`text-xs px-2 py-1 rounded transition-colors ${banner.is_active ? 'bg-green-500/15 text-green-400 hover:bg-green-500/25' : 'bg-gray-700 text-gray-500 hover:bg-gray-600'}`}
                  >
                    {banner.is_active ? 'Active' : 'Inactive'}
                  </button>
                  <button onClick={() => handleDelete(banner)} disabled={deleting === banner.id} className="p-1.5 text-gray-500 hover:text-red-400 hover:bg-red-500/10 rounded transition-colors disabled:opacity-50">
                    <Trash2 size={13} />
                  </button>
                </div>
              </div>
            ))
        )}
      </div>

      <Modal isOpen={showCreate} onClose={() => { setShowCreate(false); setForm(EMPTY_BANNER); }} title="New Banner">
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <Field label="Title">
              <input type="text" value={form.title} onChange={f('title')} className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-indigo-500" />
            </Field>
            <Field label="Subtitle">
              <input type="text" value={form.subtitle} onChange={f('subtitle')} className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-indigo-500" />
            </Field>
            <Field label="Image URL" className="col-span-2">
              <input type="text" value={form.image_url} onChange={f('image_url')} placeholder="https://..." className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-indigo-500" />
            </Field>
            <Field label="Tap Action (route/screen)">
              <input type="text" value={form.tap_action} onChange={f('tap_action')} placeholder="deep-cleaning" className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-indigo-500" />
            </Field>
            <Field label="Display Order">
              <input type="number" value={form.display_order} onChange={f('display_order')} className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-indigo-500" />
            </Field>
          </div>
          <label className="flex items-center gap-2 cursor-pointer">
            <input type="checkbox" checked={form.is_active} onChange={f('is_active')} className="w-4 h-4 accent-indigo-500" />
            <span className="text-sm text-gray-300">Active immediately</span>
          </label>
          <div className="flex justify-end gap-3 pt-2">
            <button onClick={() => { setShowCreate(false); setForm(EMPTY_BANNER); }} className="px-4 py-2 text-sm text-gray-400 hover:text-white bg-gray-800 hover:bg-gray-700 rounded-lg transition-colors">Cancel</button>
            <button onClick={handleCreate} disabled={creating} className="px-4 py-2 text-sm bg-indigo-600 hover:bg-indigo-700 text-white rounded-lg transition-colors disabled:opacity-50">
              {creating ? 'Creating...' : 'Create Banner'}
            </button>
          </div>
        </div>
      </Modal>
    </div>
  );
}

// ── Screens tab ─────────────────────────────────────────────────────────────
function ScreensTab() {
  const [screens, setScreens] = useState([]);
  const [loading, setLoading] = useState(false);
  const [editing, setEditing] = useState(null); // { key, content }
  const [saving, setSaving] = useState(false);
  const { toasts, toast } = useToast();

  const load = async () => {
    setLoading(true);
    try {
      const res = await getScreens();
      const list = Array.isArray(res) ? res : (res.screens || Object.entries(res || {}).map(([key, content]) => ({ key, content })));
      setScreens(list);
    } catch { toast('Failed to load screens', 'error'); }
    finally { setLoading(false); }
  };

  useEffect(() => { load(); }, []);

  const handleEdit = (screen) => {
    setEditing({ key: screen.key, content: typeof screen.content === 'string' ? screen.content : JSON.stringify(screen.content, null, 2) });
  };

  const handleSave = async () => {
    let parsed;
    try { parsed = JSON.parse(editing.content); } catch { toast('Invalid JSON', 'error'); return; }
    setSaving(true);
    try {
      await updateScreen(editing.key, parsed);
      toast(`Screen "${editing.key}" saved`);
      setEditing(null);
      load();
    } catch (err) { toast(err.response?.data?.error || 'Save failed', 'error'); }
    finally { setSaving(false); }
  };

  return (
    <div className="space-y-4">
      <Toaster toasts={toasts} />
      <div className="flex justify-between items-center">
        <p className="text-sm text-gray-400">{screens.length} screens</p>
        <button onClick={load} disabled={loading} className="p-2 bg-gray-800 hover:bg-gray-700 text-gray-400 rounded-lg transition-colors disabled:opacity-50">
          <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
        </button>
      </div>

      {loading && screens.length === 0 ? (
        <div className="text-center py-8 text-gray-500">Loading...</div>
      ) : screens.length === 0 ? (
        <div className="text-center py-8 text-gray-500">No screens configured</div>
      ) : (
        <div className="space-y-3">
          {screens.map((screen) => (
            <div key={screen.key} className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden">
              <div className="flex items-center justify-between px-4 py-3 border-b border-gray-800">
                <span className="text-sm font-medium text-white font-mono">{screen.key}</span>
                {editing?.key === screen.key ? (
                  <div className="flex gap-2">
                    <button onClick={handleSave} disabled={saving} className="flex items-center gap-1 px-2 py-1 text-xs bg-indigo-600 hover:bg-indigo-700 text-white rounded transition-colors disabled:opacity-50">
                      <Check size={11} /> {saving ? 'Saving...' : 'Save'}
                    </button>
                    <button onClick={() => setEditing(null)} className="flex items-center gap-1 px-2 py-1 text-xs bg-gray-700 hover:bg-gray-600 text-gray-300 rounded transition-colors">
                      <X size={11} /> Cancel
                    </button>
                  </div>
                ) : (
                  <button onClick={() => handleEdit(screen)} className="flex items-center gap-1 px-2 py-1 text-xs text-gray-400 hover:text-white hover:bg-gray-700 rounded transition-colors">
                    <Pencil size={11} /> Edit
                  </button>
                )}
              </div>
              {editing?.key === screen.key ? (
                <textarea
                  value={editing.content}
                  onChange={(e) => setEditing((p) => ({ ...p, content: e.target.value }))}
                  className="w-full bg-gray-950 text-green-400 font-mono text-xs px-4 py-3 h-40 focus:outline-none resize-none"
                />
              ) : (
                <pre className="text-xs text-gray-400 font-mono px-4 py-3 overflow-auto max-h-32">
                  {typeof screen.content === 'string' ? screen.content : JSON.stringify(screen.content, null, 2)}
                </pre>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Page ────────────────────────────────────────────────────────────────────
export default function ContentPage() {
  const [tab, setTab] = useState('Banners');

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-white">Content</h1>
        <p className="text-gray-400 text-sm mt-0.5">Banners and screen configurations</p>
      </div>

      <div className="flex gap-1 border-b border-gray-800">
        {TABS.map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`px-4 py-2 text-sm font-medium transition-colors ${
              tab === t ? 'text-indigo-400 border-b-2 border-indigo-500 -mb-px' : 'text-gray-500 hover:text-gray-300'
            }`}
          >
            {t}
          </button>
        ))}
      </div>

      {tab === 'Banners' && <BannersTab />}
      {tab === 'Screens' && <ScreensTab />}
    </div>
  );
}
