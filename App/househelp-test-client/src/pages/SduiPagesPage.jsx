import { useState, useEffect, useCallback, useMemo } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  RefreshCw, Plus, Trash2, Pencil, Play, Eye, Undo2, ShieldOff,
  ShieldAlert, ChevronDown, ChevronRight,
} from 'lucide-react';
import {
  listSduiPages, listConfigs, createDraft, updateDraft, deleteDraft,
  stageConfig, activateConfig, rollbackConfig, previewConfig,
  getSduiAuditLog, getKillSwitch, setKillSwitch, clearKillSwitch,
} from '../api/sdui.api';
import { useToast } from '../hooks/useToast';
import Toaster from '../components/Toast';
import Modal, { Field } from '../components/Modal';
import LoadingSpinner from '../components/LoadingSpinner';

const STATUS_STYLES = {
  draft:    'bg-gray-500/15    text-gray-300   border-gray-700/40',
  staged:   'bg-yellow-500/15  text-yellow-400 border-yellow-700/40',
  active:   'bg-green-500/15   text-green-400  border-green-700/40',
  archived: 'bg-slate-500/15   text-slate-400  border-slate-700/40',
};

function ConfigStatus({ status }) {
  const key = String(status ?? '').toLowerCase();
  const style = STATUS_STYLES[key] || STATUS_STYLES.draft;
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium border capitalize ${style}`}>
      {key || '—'}
    </span>
  );
}

function fmtDate(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  return d.toLocaleDateString() + ' ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

const EMPTY_DRAFT = {
  name: '', description: '', change_notes: '', version: '',
  config_json: '{\n  "page": "home",\n  "schema_version": 1,\n  "sections": []\n}',
};

export default function SduiPagesPage() {
  const [searchParams, setSearchParams] = useSearchParams();

  const [pages, setPages] = useState([]);
  const [pagesLoading, setPagesLoading] = useState(false);
  const [pageId, setPageId] = useState(searchParams.get('page') || '');

  const [configs, setConfigs] = useState([]);
  const [configsLoading, setConfigsLoading] = useState(false);

  const [killState, setKillState] = useState({ kill_switch: false, loading: false });

  const [editor, setEditor] = useState({ open: false, mode: 'create', form: EMPTY_DRAFT, etag: '', saving: false, validation: null });
  const [previewModal, setPreviewModal] = useState({ open: false, loading: false, data: null, version: '' });
  const [confirmKill, setConfirmKill] = useState(false);
  const [auditOpen, setAuditOpen] = useState(false);
  const [audit, setAudit] = useState([]);
  const [auditLoading, setAuditLoading] = useState(false);

  const { toasts, toast } = useToast();

  // ── Loaders ────────────────────────────────────────────────────────────────
  const loadPages = useCallback(async () => {
    setPagesLoading(true);
    try {
      const res = await listSduiPages();
      const list = res?.pages || [];
      setPages(list);
      if (!pageId) {
        const next = list.includes('home') ? 'home' : list[0] || '';
        if (next) {
          setPageId(next);
          setSearchParams({ page: next }, { replace: true });
        }
      }
    } catch {
      toast('Failed to load pages', 'error');
    } finally {
      setPagesLoading(false);
    }
  }, [pageId, setSearchParams, toast]);

  const loadConfigs = useCallback(async () => {
    if (!pageId) return;
    setConfigsLoading(true);
    try {
      const res = await listConfigs(pageId);
      setConfigs(res?.configs || []);
    } catch {
      toast('Failed to load configs', 'error');
    } finally {
      setConfigsLoading(false);
    }
  }, [pageId, toast]);

  const loadKill = useCallback(async () => {
    if (!pageId) return;
    try {
      const res = await getKillSwitch(pageId);
      setKillState({ kill_switch: !!res?.kill_switch, loading: false });
    } catch {
      // Non-fatal, do not toast.
    }
  }, [pageId]);

  const loadAudit = useCallback(async () => {
    if (!pageId) return;
    setAuditLoading(true);
    try {
      const res = await getSduiAuditLog(pageId, { limit: 50 });
      setAudit(res?.entries || []);
    } catch {
      toast('Failed to load audit log', 'error');
    } finally {
      setAuditLoading(false);
    }
  }, [pageId, toast]);

  useEffect(() => { loadPages(); }, [loadPages]);
  useEffect(() => { loadConfigs(); loadKill(); }, [loadConfigs, loadKill]);
  useEffect(() => { if (auditOpen) loadAudit(); }, [auditOpen, loadAudit]);

  // ── Handlers ───────────────────────────────────────────────────────────────
  const handlePageChange = (id) => {
    setPageId(id);
    setSearchParams({ page: id }, { replace: true });
  };

  const openCreate = () => {
    setEditor({ open: true, mode: 'create', form: { ...EMPTY_DRAFT }, etag: '', saving: false, validation: null });
  };

  const openEdit = (cfg) => {
    setEditor({
      open: true,
      mode: 'edit',
      form: {
        name: cfg.name || '',
        description: cfg.description || '',
        change_notes: cfg.change_notes || '',
        version: cfg.version,
        config_json: JSON.stringify(cfg.config_json ?? {}, null, 2),
      },
      etag: cfg.etag || '',
      saving: false,
      validation: null,
    });
  };

  const closeEditor = () => setEditor((e) => ({ ...e, open: false, validation: null }));

  const handleSaveDraft = async () => {
    const f = editor.form;
    if (!f.version.trim()) return toast('Version is required', 'error');
    let parsed;
    try {
      parsed = JSON.parse(f.config_json);
    } catch (err) {
      return toast('config_json is not valid JSON: ' + err.message, 'error');
    }
    setEditor((e) => ({ ...e, saving: true, validation: null }));
    try {
      const body = {
        name: f.name,
        description: f.description,
        change_notes: f.change_notes,
        version: f.version.trim(),
        config_json: parsed,
      };
      if (editor.mode === 'create') {
        await createDraft(pageId, body);
        toast(`Draft ${body.version} created`);
      } else {
        await updateDraft(pageId, f.version.trim(), {
          name: body.name,
          description: body.description,
          change_notes: body.change_notes,
          config_json: body.config_json,
        }, editor.etag);
        toast(`Draft ${body.version} updated`);
      }
      setEditor((e) => ({ ...e, open: false, saving: false }));
      loadConfigs();
    } catch (err) {
      const data = err.response?.data;
      if (data && (data.errors || data.warnings)) {
        setEditor((e) => ({ ...e, saving: false, validation: { errors: data.errors || [], warnings: data.warnings || [] } }));
      } else {
        toast(data?.error || 'Save failed', 'error');
        setEditor((e) => ({ ...e, saving: false }));
      }
    }
  };

  const handleStage = async (cfg) => {
    if (!window.confirm(`Stage draft ${cfg.version}? This validates and locks it.`)) return;
    try {
      const res = await stageConfig(pageId, cfg.version);
      toast(`${cfg.version} staged`);
      const warnings = res?.warnings;
      if (Array.isArray(warnings) && warnings.length) {
        toast(`${warnings.length} warning(s) — see audit log`, 'info');
      }
      loadConfigs();
    } catch (err) {
      const data = err.response?.data;
      if (data?.errors || data?.warnings) {
        const errs = (data.errors || []).map((e) => e.message || JSON.stringify(e)).join('; ');
        toast(`Validation failed: ${errs || 'see console'}`, 'error');
      } else {
        toast(data?.error || 'Stage failed', 'error');
      }
    }
  };

  const handleActivate = async (cfg) => {
    if (!window.confirm(`Activate ${cfg.version}? This will replace the current active config.`)) return;
    try {
      await activateConfig(pageId, cfg.version, cfg.etag);
      toast(`${cfg.version} activated`);
      loadConfigs();
    } catch (err) {
      toast(err.response?.data?.error || 'Activate failed', 'error');
    }
  };

  const handleRollback = async (cfg) => {
    if (!window.confirm(`Rollback to a previously archived config? Active version ${cfg.version} will be archived.`)) return;
    try {
      await rollbackConfig(pageId, cfg.version);
      toast('Rolled back');
      loadConfigs();
    } catch (err) {
      toast(err.response?.data?.error || 'Rollback failed', 'error');
    }
  };

  const handleDelete = async (cfg) => {
    if (!window.confirm(`Delete draft ${cfg.version}? This cannot be undone.`)) return;
    try {
      await deleteDraft(pageId, cfg.version);
      toast('Deleted');
      loadConfigs();
    } catch (err) {
      toast(err.response?.data?.error || 'Delete failed', 'error');
    }
  };

  const handlePreview = async (cfg) => {
    setPreviewModal({ open: true, loading: true, data: null, version: cfg.version });
    try {
      const data = await previewConfig(pageId, cfg.version);
      setPreviewModal({ open: true, loading: false, data, version: cfg.version });
    } catch (err) {
      setPreviewModal({ open: true, loading: false, data: { error: err.response?.data?.error || err.message }, version: cfg.version });
    }
  };

  const handleToggleKill = async () => {
    if (!killState.kill_switch) {
      setConfirmKill(true);
      return;
    }
    setKillState((s) => ({ ...s, loading: true }));
    try {
      await clearKillSwitch(pageId);
      toast('Kill-switch cleared');
      loadKill();
    } catch (err) {
      toast(err.response?.data?.error || 'Failed to clear kill-switch', 'error');
      setKillState((s) => ({ ...s, loading: false }));
    }
  };

  const confirmEnableKill = async () => {
    setConfirmKill(false);
    setKillState((s) => ({ ...s, loading: true }));
    try {
      await setKillSwitch(pageId);
      toast('Kill-switch ENABLED — page will serve safe layout', 'info');
      loadKill();
    } catch (err) {
      toast(err.response?.data?.error || 'Failed to enable kill-switch', 'error');
      setKillState((s) => ({ ...s, loading: false }));
    }
  };

  // ── Render ─────────────────────────────────────────────────────────────────
  const sortedConfigs = useMemo(() => {
    const order = { active: 0, staged: 1, draft: 2, archived: 3 };
    return [...configs].sort((a, b) => {
      const ao = order[a.status] ?? 9;
      const bo = order[b.status] ?? 9;
      if (ao !== bo) return ao - bo;
      return new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
    });
  }, [configs]);

  return (
    <div className="space-y-6">
      <Toaster toasts={toasts} />

      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-white">SDUI Pages</h1>
          <p className="text-gray-400 text-sm mt-0.5">Server-driven UI config lifecycle</p>
        </div>
        <div className="flex gap-2">
          <button
            onClick={() => { loadConfigs(); loadKill(); }}
            disabled={configsLoading || !pageId}
            className="flex items-center gap-2 px-3 py-2 bg-gray-800 hover:bg-gray-700 text-gray-300 rounded-lg text-sm transition-colors disabled:opacity-50"
          >
            <RefreshCw size={14} className={configsLoading ? 'animate-spin' : ''} />
          </button>
          <button
            onClick={openCreate}
            disabled={!pageId}
            className="flex items-center gap-2 px-3 py-2 bg-indigo-600 hover:bg-indigo-700 text-white rounded-lg text-sm transition-colors disabled:opacity-50"
          >
            <Plus size={14} /> New draft
          </button>
        </div>
      </div>

      {/* Page selector + kill-switch */}
      <div className="bg-gray-900 border border-gray-800 rounded-xl p-4 flex flex-wrap items-center gap-4">
        <div className="flex items-center gap-3">
          <label className="text-xs uppercase tracking-wider text-gray-500 font-semibold">Page</label>
          {pagesLoading ? (
            <LoadingSpinner text="Loading pages..." />
          ) : (
            <select
              value={pageId}
              onChange={(e) => handlePageChange(e.target.value)}
              className="bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-indigo-500 min-w-44"
            >
              {pages.length === 0 && <option value="">— no pages —</option>}
              {pages.map((p) => (
                <option key={p} value={p}>{p}</option>
              ))}
            </select>
          )}
        </div>

        {pageId && (
          <div className="ml-auto flex items-center gap-3">
            <span className="text-xs text-gray-500 uppercase tracking-wider font-semibold">Kill-switch</span>
            <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium border ${
              killState.kill_switch ? 'bg-red-500/15 text-red-400 border-red-700/40' : 'bg-green-500/15 text-green-400 border-green-700/40'
            }`}>
              {killState.kill_switch ? 'ENABLED' : 'off'}
            </span>
            <button
              onClick={handleToggleKill}
              disabled={killState.loading}
              className={`flex items-center gap-2 px-3 py-2 rounded-lg text-sm transition-colors disabled:opacity-50 ${
                killState.kill_switch
                  ? 'bg-gray-800 hover:bg-gray-700 text-gray-200'
                  : 'bg-red-600/80 hover:bg-red-600 text-white'
              }`}
            >
              {killState.kill_switch ? <ShieldOff size={14} /> : <ShieldAlert size={14} />}
              {killState.kill_switch ? 'Clear' : 'Enable'}
            </button>
          </div>
        )}
      </div>

      {/* Configs table */}
      <div className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden">
        <div className="px-4 py-3 border-b border-gray-800 flex items-center justify-between">
          <h2 className="text-sm font-semibold text-white">
            Configs {pageId && <span className="text-gray-500 font-normal">— {pageId}</span>}
          </h2>
          <span className="text-xs text-gray-500">{sortedConfigs.length} total</span>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-800 text-xs text-gray-500 uppercase tracking-wide">
                <th className="text-left px-4 py-3 font-medium">Version</th>
                <th className="text-left px-4 py-3 font-medium">Status</th>
                <th className="text-left px-4 py-3 font-medium">Env</th>
                <th className="text-left px-4 py-3 font-medium">Name</th>
                <th className="text-left px-4 py-3 font-medium">Created</th>
                <th className="text-left px-4 py-3 font-medium">ETag</th>
                <th className="px-4 py-3" />
              </tr>
            </thead>
            <tbody>
              {configsLoading && sortedConfigs.length === 0 ? (
                <tr><td colSpan={7} className="text-center py-8 text-gray-500">Loading...</td></tr>
              ) : sortedConfigs.length === 0 ? (
                <tr><td colSpan={7} className="text-center py-8 text-gray-500">{pageId ? 'No configs yet' : 'Select a page'}</td></tr>
              ) : (
                sortedConfigs.map((cfg) => (
                  <tr key={`${cfg.version}-${cfg.env}-${cfg.id}`} className="border-b border-gray-800/50 hover:bg-gray-800/30 transition-colors">
                    <td className="px-4 py-3 font-mono text-indigo-400">{cfg.version}</td>
                    <td className="px-4 py-3"><ConfigStatus status={cfg.status} /></td>
                    <td className="px-4 py-3 text-gray-400 text-xs uppercase">{cfg.env}</td>
                    <td className="px-4 py-3 text-gray-200 truncate max-w-[200px]">{cfg.name || <span className="text-gray-600">—</span>}</td>
                    <td className="px-4 py-3 text-gray-500 text-xs whitespace-nowrap">{fmtDate(cfg.created_at)}</td>
                    <td className="px-4 py-3 font-mono text-[10px] text-gray-600">{cfg.etag?.slice(0, 10)}…</td>
                    <td className="px-4 py-3">
                      <div className="flex justify-end gap-1">
                        {cfg.status === 'draft' && (
                          <>
                            <ActionBtn icon={Pencil} label="Edit" onClick={() => openEdit(cfg)} />
                            <ActionBtn icon={Play} label="Stage" onClick={() => handleStage(cfg)} tone="indigo" />
                            <ActionBtn icon={Trash2} label="Delete" onClick={() => handleDelete(cfg)} tone="red" />
                          </>
                        )}
                        {cfg.status === 'staged' && (
                          <>
                            <ActionBtn icon={Eye} label="Preview" onClick={() => handlePreview(cfg)} />
                            <ActionBtn icon={Play} label="Activate" onClick={() => handleActivate(cfg)} tone="green" />
                          </>
                        )}
                        {cfg.status === 'active' && (
                          <>
                            <ActionBtn icon={Eye} label="Preview" onClick={() => handlePreview(cfg)} />
                            <ActionBtn icon={Undo2} label="Rollback" onClick={() => handleRollback(cfg)} tone="orange" />
                          </>
                        )}
                        {cfg.status === 'archived' && (
                          <ActionBtn icon={Eye} label="Preview" onClick={() => handlePreview(cfg)} />
                        )}
                      </div>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Audit log section */}
      <div className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden">
        <button
          onClick={() => setAuditOpen((o) => !o)}
          className="w-full flex items-center justify-between px-4 py-3 border-b border-gray-800 hover:bg-gray-800/30 transition-colors"
        >
          <h2 className="text-sm font-semibold text-white flex items-center gap-2">
            {auditOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
            Audit Log
          </h2>
          <span className="text-xs text-gray-500">{audit.length ? `${audit.length} entries` : 'click to load'}</span>
        </button>
        {auditOpen && (
          <div className="overflow-x-auto">
            {auditLoading ? (
              <div className="px-4 py-6"><LoadingSpinner text="Loading audit log..." /></div>
            ) : audit.length === 0 ? (
              <div className="px-4 py-6 text-center text-gray-500 text-sm">No entries</div>
            ) : (
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-gray-800 text-xs text-gray-500 uppercase tracking-wide">
                    <th className="text-left px-4 py-3 font-medium">Time</th>
                    <th className="text-left px-4 py-3 font-medium">Action</th>
                    <th className="text-left px-4 py-3 font-medium">Actor</th>
                    <th className="text-left px-4 py-3 font-medium">Note</th>
                  </tr>
                </thead>
                <tbody>
                  {audit.map((e) => (
                    <tr key={e.id} className="border-b border-gray-800/50">
                      <td className="px-4 py-2 text-xs text-gray-500 whitespace-nowrap">{fmtDate(e.created_at)}</td>
                      <td className="px-4 py-2 text-xs font-semibold text-indigo-400">{e.action}</td>
                      <td className="px-4 py-2 font-mono text-[10px] text-gray-500">{e.actor?.slice(0, 8) || '—'}…</td>
                      <td className="px-4 py-2 text-xs text-gray-400 truncate max-w-[400px]">{e.note || '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        )}
      </div>

      {/* Editor modal */}
      <Modal
        isOpen={editor.open}
        onClose={closeEditor}
        title={editor.mode === 'create' ? 'New draft' : `Edit draft ${editor.form.version}`}
        maxWidth="max-w-3xl"
      >
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <Field label="Version">
              <input
                type="text"
                value={editor.form.version}
                disabled={editor.mode === 'edit'}
                onChange={(e) => setEditor((s) => ({ ...s, form: { ...s.form, version: e.target.value } }))}
                placeholder="v1.0.0"
                className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white font-mono placeholder-gray-600 focus:outline-none focus:border-indigo-500 disabled:opacity-60"
              />
            </Field>
            <Field label="Name">
              <input
                type="text"
                value={editor.form.name}
                onChange={(e) => setEditor((s) => ({ ...s, form: { ...s.form, name: e.target.value } }))}
                className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-indigo-500"
              />
            </Field>
          </div>
          <Field label="Description">
            <input
              type="text"
              value={editor.form.description}
              onChange={(e) => setEditor((s) => ({ ...s, form: { ...s.form, description: e.target.value } }))}
              className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-indigo-500"
            />
          </Field>
          <Field label="Change notes">
            <input
              type="text"
              value={editor.form.change_notes}
              onChange={(e) => setEditor((s) => ({ ...s, form: { ...s.form, change_notes: e.target.value } }))}
              className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-indigo-500"
            />
          </Field>
          <Field label="config_json" hint="Raw JSON. Validated server-side on stage.">
            <textarea
              value={editor.form.config_json}
              onChange={(e) => setEditor((s) => ({ ...s, form: { ...s.form, config_json: e.target.value } }))}
              rows={16}
              spellCheck={false}
              className="w-full bg-gray-950 border border-gray-700 rounded-lg px-3 py-2 text-xs text-green-400 font-mono focus:outline-none focus:border-indigo-500 resize-y"
            />
          </Field>

          {editor.validation && (
            <div className="rounded-lg border border-red-700/50 bg-red-900/15 p-3 space-y-2">
              {editor.validation.errors?.length > 0 && (
                <div>
                  <p className="text-xs uppercase tracking-wide text-red-400 font-semibold mb-1">Errors</p>
                  <ul className="space-y-1 text-xs text-red-300 font-mono">
                    {editor.validation.errors.map((er, i) => (
                      <li key={i}>• {er.path ? `${er.path}: ` : ''}{er.message || JSON.stringify(er)}</li>
                    ))}
                  </ul>
                </div>
              )}
              {editor.validation.warnings?.length > 0 && (
                <div>
                  <p className="text-xs uppercase tracking-wide text-yellow-400 font-semibold mb-1">Warnings</p>
                  <ul className="space-y-1 text-xs text-yellow-300 font-mono">
                    {editor.validation.warnings.map((w, i) => (
                      <li key={i}>• {w.path ? `${w.path}: ` : ''}{w.message || JSON.stringify(w)}</li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          )}

          <div className="flex justify-end gap-3 pt-2">
            <button onClick={closeEditor} className="px-4 py-2 text-sm text-gray-400 hover:text-white bg-gray-800 hover:bg-gray-700 rounded-lg transition-colors">
              Cancel
            </button>
            <button onClick={handleSaveDraft} disabled={editor.saving} className="px-4 py-2 text-sm bg-indigo-600 hover:bg-indigo-700 text-white rounded-lg transition-colors disabled:opacity-50">
              {editor.saving ? 'Saving...' : editor.mode === 'create' ? 'Create draft' : 'Save changes'}
            </button>
          </div>
        </div>
      </Modal>

      {/* Preview modal */}
      <Modal
        isOpen={previewModal.open}
        onClose={() => setPreviewModal({ open: false, loading: false, data: null, version: '' })}
        title={`Preview — ${previewModal.version}`}
        maxWidth="max-w-3xl"
      >
        {previewModal.loading ? (
          <LoadingSpinner text="Resolving preview..." />
        ) : (
          <pre className="bg-gray-950 border border-gray-800 rounded-lg p-3 text-xs text-green-400 font-mono overflow-auto max-h-[60vh]">
            {JSON.stringify(previewModal.data, null, 2)}
          </pre>
        )}
      </Modal>

      {/* Confirm kill modal */}
      <Modal
        isOpen={confirmKill}
        onClose={() => setConfirmKill(false)}
        title="Enable kill-switch?"
      >
        <div className="space-y-4">
          <p className="text-sm text-gray-300">
            This will stop serving the active config for <span className="font-mono text-indigo-400">{pageId}</span>. Clients will receive the safe-layout fallback until the switch is cleared. Use only during incidents.
          </p>
          <div className="flex justify-end gap-3">
            <button onClick={() => setConfirmKill(false)} className="px-4 py-2 text-sm text-gray-400 hover:text-white bg-gray-800 hover:bg-gray-700 rounded-lg transition-colors">
              Cancel
            </button>
            <button onClick={confirmEnableKill} className="px-4 py-2 text-sm bg-red-600 hover:bg-red-700 text-white rounded-lg transition-colors">
              Enable kill-switch
            </button>
          </div>
        </div>
      </Modal>
    </div>
  );
}

function ActionBtn({ icon: Icon, label, onClick, tone = 'gray' }) {
  const tones = {
    gray:   'text-gray-300 hover:text-white hover:bg-gray-700/60',
    indigo: 'text-indigo-300 hover:text-indigo-200 hover:bg-indigo-500/15',
    green:  'text-green-300 hover:text-green-200 hover:bg-green-500/15',
    red:    'text-red-400 hover:text-red-300 hover:bg-red-500/15',
    orange: 'text-orange-300 hover:text-orange-200 hover:bg-orange-500/15',
  };
  return (
    <button
      onClick={onClick}
      title={label}
      className={`flex items-center gap-1 px-2 py-1 text-xs rounded transition-colors ${tones[tone] || tones.gray}`}
    >
      <Icon size={12} /> {label}
    </button>
  );
}
