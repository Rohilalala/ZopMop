import { useState, useEffect } from 'react';
import { RefreshCw, Save, ChevronDown, ChevronUp } from 'lucide-react';
import { getConfig, updateConfig, bulkUpdateConfig } from '../api/admin.api';
import { useToast } from '../hooks/useToast';
import Toaster from '../components/Toast';

export default function ConfigPage() {
  const [configs, setConfigs] = useState([]);
  const [loading, setLoading] = useState(false);
  const [edits, setEdits] = useState({});
  const [saving, setSaving] = useState(null);
  const [showBulk, setShowBulk] = useState(false);
  const [bulkJson, setBulkJson] = useState('{\n  "app.maintenance_mode": "false"\n}');
  const [bulking, setBulking] = useState(false);
  const { toasts, toast } = useToast();

  const load = async () => {
    setLoading(true);
    try {
      const res = await getConfig();
      setConfigs(res.configs || res || []);
      setEdits({});
    } catch {
      toast('Failed to load config', 'error');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);

  const getValue = (cfg) => edits[cfg.key] !== undefined ? edits[cfg.key] : cfg.value;
  const isDirty = (cfg) => edits[cfg.key] !== undefined && edits[cfg.key] !== cfg.value;

  const handleSave = async (cfg) => {
    if (!isDirty(cfg)) return;
    setSaving(cfg.key);
    try {
      await updateConfig(cfg.key, edits[cfg.key]);
      toast(`${cfg.key} saved`);
      setConfigs((prev) => prev.map((c) => c.key === cfg.key ? { ...c, value: edits[cfg.key] } : c));
      setEdits((prev) => { const n = { ...prev }; delete n[cfg.key]; return n; });
    } catch (err) {
      toast(err.response?.data?.error || 'Save failed', 'error');
    } finally {
      setSaving(null);
    }
  };

  const handleBulk = async () => {
    let parsed;
    try { parsed = JSON.parse(bulkJson); } catch { toast('Invalid JSON', 'error'); return; }
    setBulking(true);
    try {
      // Backend expects map[string]string, not an array of {key,value} pairs.
      const payload = Object.fromEntries(
        Object.entries(parsed).map(([key, value]) => [key, String(value)])
      );
      await bulkUpdateConfig(payload);
      toast(`${Object.keys(payload).length} keys updated`);
      setShowBulk(false);
      load();
    } catch (err) {
      toast(err.response?.data?.error || 'Bulk update failed', 'error');
    } finally {
      setBulking(false);
    }
  };

  // Group by prefix
  const grouped = configs.reduce((acc, cfg) => {
    const prefix = cfg.key.split('.')[0] || 'other';
    (acc[prefix] = acc[prefix] || []).push(cfg);
    return acc;
  }, {});

  return (
    <div className="space-y-6">
      <Toaster toasts={toasts} />

      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-white">Config</h1>
          <p className="text-gray-400 text-sm mt-0.5">Live business configuration — no deploy needed</p>
        </div>
        <div className="flex gap-2">
          <button onClick={() => setShowBulk((v) => !v)} className="flex items-center gap-1.5 px-3 py-2 bg-gray-800 hover:bg-gray-700 text-gray-300 rounded-lg text-sm transition-colors">
            Bulk Edit {showBulk ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
          </button>
          <button onClick={load} disabled={loading} className="flex items-center gap-2 px-3 py-2 bg-gray-800 hover:bg-gray-700 text-gray-300 rounded-lg text-sm transition-colors disabled:opacity-50">
            <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
          </button>
        </div>
      </div>

      {/* Bulk panel */}
      {showBulk && (
        <div className="bg-gray-900 border border-gray-800 rounded-xl p-5 space-y-3">
          <p className="text-sm font-medium text-white">Bulk Update</p>
          <p className="text-xs text-gray-500">JSON object of key→value pairs. Values are stored as strings.</p>
          <textarea
            value={bulkJson}
            onChange={(e) => setBulkJson(e.target.value)}
            className="w-full bg-gray-950 border border-gray-700 rounded-lg px-3 py-2 text-green-400 font-mono text-xs h-28 focus:outline-none focus:border-indigo-500 resize-none"
          />
          <div className="flex justify-end">
            <button onClick={handleBulk} disabled={bulking} className="flex items-center gap-2 px-4 py-2 bg-indigo-600 hover:bg-indigo-700 text-white rounded-lg text-sm transition-colors disabled:opacity-50">
              <Save size={13} /> {bulking ? 'Saving...' : 'Apply Bulk'}
            </button>
          </div>
        </div>
      )}

      {/* Config table grouped by prefix */}
      {loading && configs.length === 0 ? (
        <div className="text-center py-12 text-gray-500">Loading...</div>
      ) : (
        Object.entries(grouped).map(([prefix, items]) => (
          <div key={prefix} className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden">
            <div className="px-4 py-2 border-b border-gray-800">
              <span className="text-xs font-semibold text-gray-500 uppercase tracking-widest">{prefix}</span>
            </div>
            <table className="w-full text-sm">
              <tbody>
                {items.map((cfg) => (
                  <tr key={cfg.key} className="border-b border-gray-800/50 hover:bg-gray-800/30 transition-colors">
                    <td className="px-4 py-3 w-2/5">
                      <p className="font-mono text-xs text-indigo-400 font-semibold">{cfg.key}</p>
                      {cfg.description && <p className="text-xs text-gray-500 mt-0.5">{cfg.description}</p>}
                      {cfg.value_type && (
                        <span className="mt-1 inline-block px-1.5 py-0.5 bg-gray-800 rounded text-[10px] text-gray-500 font-mono">
                          {cfg.value_type}
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      <input
                        type="text"
                        value={getValue(cfg)}
                        onChange={(e) => setEdits((prev) => ({ ...prev, [cfg.key]: e.target.value }))}
                        className={`w-full bg-gray-950 border rounded-lg px-3 py-1.5 text-sm font-mono focus:outline-none transition-colors ${
                          isDirty(cfg) ? 'border-indigo-500 text-white' : 'border-gray-700 text-gray-300'
                        }`}
                      />
                    </td>
                    <td className="px-4 py-3 w-20 text-right">
                      <button
                        onClick={() => handleSave(cfg)}
                        disabled={!isDirty(cfg) || saving === cfg.key}
                        className="flex items-center gap-1 px-2.5 py-1.5 bg-indigo-600 hover:bg-indigo-700 text-white rounded-lg text-xs font-medium transition-colors disabled:opacity-30 ml-auto"
                      >
                        <Save size={11} />
                        {saving === cfg.key ? '...' : 'Save'}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ))
      )}
    </div>
  );
}
