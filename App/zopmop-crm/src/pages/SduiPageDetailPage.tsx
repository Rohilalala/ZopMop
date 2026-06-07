import { Fragment, useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  AlertTriangle, ArrowLeft, CheckCircle2, Eye, FlaskConical, Pencil, Plus, RotateCcw, ShieldAlert, Trash2, Upload,
} from 'lucide-react';

import {
  sduiApi, sduiKeys,
  type ConfigRecord, type ConfigStatus, type Env, type ValidationResult,
} from '@/api/sdui';
import { Card, EmptyState, Skeleton, StatusPill } from '@/components/ui';
import { ConfirmModal, Modal } from '@/components/ui/Modal';
import { showToast } from '@/components/ui/Toast';
import { Can } from '@/auth/Can';
import { usePermission } from '@/auth/usePermission';
import { LazyJsonEditor, LazyJsonViewer } from '@/components/sdui/LazyJsonEditor';
import { SduiVisualPreview } from '@/components/sdui/SduiVisualPreview';

const ENV: Env = 'production';

const STATUS_TONE: Record<ConfigStatus, 'success' | 'warning' | 'info' | 'neutral'> = {
  active: 'success',
  staged: 'warning',
  draft: 'info',
  archived: 'neutral',
};

const STARTER_CONFIG = (pageId: string, version: string) =>
  JSON.stringify({ page_id: pageId, version, schema_version: 1, sections: [] }, null, 2);

export function SduiPageDetailPage() {
  const { pageId = '' } = useParams();
  const nav = useNavigate();
  const qc = useQueryClient();

  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<ConfigRecord | null>(null);
  const [previewing, setPreviewing] = useState<ConfigRecord | null>(null);
  const [toDelete, setToDelete] = useState<ConfigRecord | null>(null);
  const [toActivate, setToActivate] = useState<ConfigRecord | null>(null);
  const [toRollback, setToRollback] = useState(false);
  // Per-version validation surface returned by stage().
  const [validation, setValidation] = useState<Record<string, ValidationResult>>({});

  const canWrite = usePermission('sdui.write');
  const canActivate = usePermission('sdui.activate');

  const configsQ = useQuery({
    queryKey: sduiKeys.configs(pageId, ENV),
    queryFn: () => sduiApi.listConfigs(pageId, ENV),
  });

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: sduiKeys.configs(pageId, ENV) });
    qc.invalidateQueries({ queryKey: sduiKeys.audit(pageId) });
  };

  const stage = useMutation({
    mutationFn: (c: ConfigRecord) => sduiApi.stage(pageId, c.version),
    onSuccess: (res, c) => {
      setValidation((v) => ({
        ...v,
        [c.version]: res.ok ? { errors: [], warnings: res.warnings } : res.validation,
      }));
      if (res.ok) {
        showToast({ kind: 'success', message: `v${c.version} staged.` });
        invalidate();
      } else {
        showToast({ kind: 'error', message: `Validation failed for v${c.version}.` });
      }
    },
  });

  const activate = useMutation({
    mutationFn: async (c: ConfigRecord) => {
      // Always re-fetch to capture a fresh ETag right before activate — the
      // listing payload's etag may be stale if the row changed underneath us.
      const { etag } = await sduiApi.getConfig(pageId, c.version, ENV);
      return sduiApi.activate(pageId, c.version, etag);
    },
    onSuccess: (_d, c) => {
      showToast({ kind: 'success', message: `v${c.version} activated.` });
      invalidate();
      setToActivate(null);
    },
  });

  const del = useMutation({
    mutationFn: (c: ConfigRecord) => sduiApi.deleteDraft(pageId, c.version),
    onSuccess: (_d, c) => {
      showToast({ kind: 'success', message: `Draft v${c.version} deleted.` });
      invalidate();
      setToDelete(null);
    },
  });

  const rollback = useMutation({
    mutationFn: () => sduiApi.rollback(pageId, ENV),
    onSuccess: () => {
      showToast({ kind: 'success', message: 'Rolled back to previous config.' });
      invalidate();
      setToRollback(false);
    },
  });

  const configs = configsQ.data ?? [];

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-end justify-between">
        <div>
          <button className="btn-ghost mb-2 !px-0" onClick={() => nav('/sdui')}>
            <ArrowLeft className="w-4 h-4" />All pages
          </button>
          <h1 className="text-2xl font-semibold font-mono">{pageId}</h1>
          <p className="text-sm text-text-secondary mt-1">Config lifecycle · environment: {ENV}</p>
        </div>
        <div className="flex gap-2">
          <Can perm="sdui.activate">
            <button
              className="btn-ghost text-warning"
              onClick={() => setToRollback(true)}
            >
              <RotateCcw className="w-4 h-4" />Rollback
            </button>
          </Can>
          <Can perm="sdui.write">
            <button className="btn-primary" onClick={() => setCreating(true)}>
              <Plus className="w-4 h-4" />New draft
            </button>
          </Can>
        </div>
      </div>

      <KillSwitchCard pageId={pageId} />

      <Card className="!p-0 overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-surface-elevated text-text-muted text-xs uppercase tracking-wider">
            <tr>
              <th className="px-4 py-3 text-left">Version</th>
              <th className="px-4 py-3 text-left">Status</th>
              <th className="px-4 py-3 text-left">Name</th>
              <th className="px-4 py-3 text-left">Updated</th>
              <th className="px-4 py-3 text-right">Actions</th>
            </tr>
          </thead>
          <tbody>
            {configsQ.isLoading ? (
              [...Array(4)].map((_, i) => (
                <tr key={i} className="border-t border-border">
                  {[...Array(5)].map((_, j) => (
                    <td key={j} className="px-4 py-3"><Skeleton className="h-4" /></td>
                  ))}
                </tr>
              ))
            ) : configs.length === 0 ? (
              <tr><td colSpan={5}><EmptyState title="No configs" body="Create a draft to get started." /></td></tr>
            ) : (
              configs.map((c) => {
                const v = validation[c.version];
                return (
                  <Fragment key={c.version}>
                    <tr className="border-t border-border align-top">
                      <td className="px-4 py-3 font-mono">{c.version}</td>
                      <td className="px-4 py-3"><StatusPill tone={STATUS_TONE[c.status]}>{c.status}</StatusPill></td>
                      <td className="px-4 py-3 text-text-secondary">{c.name || '—'}</td>
                      <td className="px-4 py-3 text-text-secondary">
                        {new Date(c.activated_at || c.staged_at || c.created_at).toLocaleString()}
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex justify-end gap-1 flex-wrap">
                          <button className="btn-ghost !px-2" title="Preview" onClick={() => setPreviewing(c)}>
                            <Eye className="w-4 h-4" />
                          </button>
                          {c.status === 'draft' && (
                            <>
                              <button
                                className="btn-ghost !px-2" title="Edit draft"
                                disabled={!canWrite}
                                onClick={() => { if (!canWrite) { showToast({ kind: 'error', message: 'Insufficient permissions' }); return; } setEditing(c); }}
                              >
                                <Pencil className="w-4 h-4" />
                              </button>
                              <button
                                className="btn-ghost !px-2 text-warning" title="Stage"
                                disabled={!canWrite || stage.isPending}
                                onClick={() => { if (!canWrite) { showToast({ kind: 'error', message: 'Insufficient permissions' }); return; } stage.mutate(c); }}
                              >
                                <Upload className="w-4 h-4" />
                              </button>
                              <button
                                className="btn-ghost !px-2 text-danger" title="Delete draft"
                                disabled={!canWrite}
                                onClick={() => { if (!canWrite) { showToast({ kind: 'error', message: 'Insufficient permissions' }); return; } setToDelete(c); }}
                              >
                                <Trash2 className="w-4 h-4" />
                              </button>
                            </>
                          )}
                          {c.status === 'staged' && (
                            <button
                              className="btn-primary !px-3" title="Activate"
                              disabled={!canActivate || (v && v.errors.length > 0)}
                              onClick={() => { if (!canActivate) { showToast({ kind: 'error', message: 'Insufficient permissions' }); return; } setToActivate(c); }}
                            >
                              <CheckCircle2 className="w-4 h-4" />Activate
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                    {(v && (v.errors.length > 0 || v.warnings.length > 0)) && (
                      <tr className="border-t-0">
                        <td colSpan={5} className="px-4 pb-3">
                          <ValidationPanel result={v} />
                        </td>
                      </tr>
                    )}
                    {c.experiment_id && (
                      <tr className="border-t-0">
                        <td colSpan={5} className="px-4 pb-3">
                          <ExperimentKillSwitch expId={c.experiment_id} />
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })
            )}
          </tbody>
        </table>
      </Card>

      <AuditLogPanel pageId={pageId} />

      {(creating || editing) && (
        <DraftEditor
          pageId={pageId}
          config={editing}
          onClose={() => { setCreating(false); setEditing(null); }}
          onSaved={invalidate}
        />
      )}

      {previewing && (
        <PreviewModal pageId={pageId} config={previewing} onClose={() => setPreviewing(null)} />
      )}

      <ConfirmModal
        open={!!toDelete}
        onClose={() => setToDelete(null)}
        onConfirm={() => del.mutateAsync(toDelete!)}
        title="Delete draft?"
        destructive
        impact={<span>Draft <code className="font-mono">v{toDelete?.version}</code> will be permanently deleted.</span>}
        confirmLabel="Delete"
      />
      <ConfirmModal
        open={!!toActivate}
        onClose={() => setToActivate(null)}
        onConfirm={() => activate.mutateAsync(toActivate!)}
        title="Activate config?"
        impact={
          <span>
            <code className="font-mono">v{toActivate?.version}</code> goes live to all users immediately. The currently active config is archived (and can be rolled back to).
          </span>
        }
        confirmLabel="Activate"
      />
      <ConfirmModal
        open={toRollback}
        onClose={() => setToRollback(false)}
        onConfirm={() => rollback.mutateAsync()}
        title="Rollback to previous config?"
        destructive
        impact="The current active config is archived and the most recently archived config is re-activated for all users immediately."
        confirmLabel="Rollback"
      />
    </div>
  );
}

function ValidationPanel({ result }: { result: ValidationResult }) {
  return (
    <div className="space-y-2">
      {result.errors.length > 0 && (
        <div className="rounded-xl border border-danger/30 bg-danger/10 p-3">
          <div className="flex items-center gap-2 text-danger text-xs font-semibold uppercase tracking-wider mb-1.5">
            <AlertTriangle className="w-4 h-4" />{result.errors.length} error{result.errors.length > 1 ? 's' : ''}
          </div>
          <ul className="list-disc pl-5 space-y-0.5 text-sm text-text-secondary">
            {result.errors.map((e, i) => <li key={i} className="font-mono text-xs">{e}</li>)}
          </ul>
        </div>
      )}
      {result.warnings.length > 0 && (
        <div className="rounded-xl border border-warning/30 bg-warning/10 p-3">
          <div className="flex items-center gap-2 text-warning text-xs font-semibold uppercase tracking-wider mb-1.5">
            <AlertTriangle className="w-4 h-4" />{result.warnings.length} warning{result.warnings.length > 1 ? 's' : ''}
          </div>
          <ul className="list-disc pl-5 space-y-0.5 text-sm text-text-secondary">
            {result.warnings.map((w, i) => <li key={i} className="font-mono text-xs">{w}</li>)}
          </ul>
        </div>
      )}
    </div>
  );
}

// ── kill switch ────────────────────────────────────────────────────────────

function KillSwitchCard({ pageId }: { pageId: string }) {
  const qc = useQueryClient();
  const [confirm, setConfirm] = useState(false);
  const canActivate = usePermission('sdui.activate');

  const q = useQuery({ queryKey: sduiKeys.kill(pageId), queryFn: () => sduiApi.killStatus(pageId) });
  const on = q.data === true;

  const toggle = useMutation({
    mutationFn: () => (on ? sduiApi.killOff(pageId) : sduiApi.killOn(pageId)),
    onSuccess: () => {
      showToast({ kind: 'success', message: on ? 'Kill switch disabled.' : 'Kill switch enabled.' });
      qc.invalidateQueries({ queryKey: sduiKeys.kill(pageId) });
      qc.invalidateQueries({ queryKey: sduiKeys.audit(pageId) });
      setConfirm(false);
    },
  });

  return (
    <Card className={on ? '!border-danger/40' : ''}>
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <ShieldAlert className={`w-5 h-5 ${on ? 'text-danger' : 'text-text-muted'}`} />
          <div>
            <div className="text-sm font-medium">Kill switch</div>
            <div className="text-xs text-text-secondary">
              {on
                ? 'Active — clients fall back to the safe baked-in layout for this page.'
                : 'Off — clients receive the active config.'}
            </div>
          </div>
        </div>
        <button
          className={on ? 'btn-ghost text-success' : 'btn-danger'}
          disabled={q.isLoading || !canActivate}
          title={!canActivate ? 'Insufficient permissions' : undefined}
          onClick={() => {
            if (!canActivate) { showToast({ kind: 'error', message: 'Insufficient permissions' }); return; }
            if (on) toggle.mutate();
            else setConfirm(true);
          }}
        >
          {on ? 'Disable' : 'Enable kill switch'}
        </button>
      </div>

      <ConfirmModal
        open={confirm}
        onClose={() => setConfirm(false)}
        onConfirm={() => toggle.mutateAsync()}
        title="Enable kill switch?"
        destructive
        impact={<span>All clients will immediately stop receiving the active config for <code className="font-mono">{pageId}</code> and fall back to the safe baked-in layout.</span>}
        confirmLabel="Enable"
      />
    </Card>
  );
}

function ExperimentKillSwitch({ expId }: { expId: string }) {
  const [confirm, setConfirm] = useState(false);
  const canActivate = usePermission('sdui.activate');

  const on = useMutation({
    mutationFn: () => sduiApi.expKillOn(expId),
    onSuccess: () => { showToast({ kind: 'success', message: 'Experiment kill switch enabled.' }); setConfirm(false); },
  });
  const off = useMutation({
    mutationFn: () => sduiApi.expKillOff(expId),
    onSuccess: () => { showToast({ kind: 'success', message: 'Experiment kill switch disabled.' }); },
  });

  return (
    <div className="rounded-xl border border-border bg-surface-elevated p-3 flex items-center justify-between">
      <div className="flex items-center gap-2 text-sm">
        <FlaskConical className="w-4 h-4 text-text-muted" />
        Experiment <code className="font-mono">{expId}</code>
      </div>
      <div className="flex gap-2">
        <button
          className="btn-danger !py-1 !text-xs"
          disabled={!canActivate}
          onClick={() => { if (!canActivate) { showToast({ kind: 'error', message: 'Insufficient permissions' }); return; } setConfirm(true); }}
        >
          Kill experiment
        </button>
        <button
          className="btn-ghost !py-1 !text-xs"
          disabled={!canActivate || off.isPending}
          onClick={() => { if (!canActivate) { showToast({ kind: 'error', message: 'Insufficient permissions' }); return; } off.mutate(); }}
        >
          Clear
        </button>
      </div>

      <ConfirmModal
        open={confirm}
        onClose={() => setConfirm(false)}
        onConfirm={() => on.mutateAsync()}
        title="Kill experiment?"
        destructive
        impact={<span>All users will fall back to the control variant for experiment <code className="font-mono">{expId}</code> immediately.</span>}
        confirmLabel="Kill"
      />
    </div>
  );
}

// ── draft editor ─────────────────────────────────────────────────────────

function DraftEditor({
  pageId, config, onClose, onSaved,
}: {
  pageId: string;
  config: ConfigRecord | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const isEdit = !!config;
  const [version, setVersion] = useState(config?.version ?? '');
  const [name, setName] = useState(config?.name ?? '');
  const [changeNotes, setChangeNotes] = useState(config?.change_notes ?? '');
  const [experimentId, setExperimentId] = useState(config?.experiment_id ?? '');
  const [json, setJson] = useState(() =>
    config ? JSON.stringify(config.config_json, null, 2) : STARTER_CONFIG(pageId, ''),
  );
  const [jsonOk, setJsonOk] = useState(true);
  // ETag captured via getConfig for the optimistic-lock PATCH. Loaded lazily
  // when an existing draft is opened.
  const [etag, setEtag] = useState('');

  // For edits, fetch the latest record to capture a fresh ETag before patching.
  const etagQ = useQuery({
    queryKey: sduiKeys.config(pageId, config?.version ?? '', ENV),
    queryFn: () => sduiApi.getConfig(pageId, config!.version, ENV),
    enabled: isEdit,
  });
  useEffect(() => {
    if (etagQ.data?.etag) setEtag(etagQ.data.etag);
  }, [etagQ.data?.etag]);

  const save = useMutation({
    mutationFn: async () => {
      const parsed = JSON.parse(json);
      if (isEdit) {
        await sduiApi.patchDraft(
          pageId, config!.version,
          { config_json: parsed, name, change_notes: changeNotes, experiment_id: experimentId || undefined },
          etag,
        );
      } else {
        await sduiApi.createDraft(pageId, {
          version, env: ENV, config_json: parsed, name,
          change_notes: changeNotes, experiment_id: experimentId || undefined,
        });
      }
    },
    onSuccess: () => {
      showToast({ kind: 'success', message: isEdit ? 'Draft saved.' : 'Draft created.' });
      onSaved();
      onClose();
    },
  });

  const valid = jsonOk && (isEdit || version.trim().length > 0) && (!isEdit || !!etag);

  return (
    <Modal open onClose={onClose} title={isEdit ? `Edit draft v${config?.version}` : 'New draft'} width="max-w-3xl">
      <div className="space-y-3">
        <div className="grid grid-cols-2 gap-3">
          <input
            className="input font-mono"
            placeholder="Version (e.g. 3)"
            value={version}
            disabled={isEdit}
            onChange={(e) => setVersion(e.target.value)}
          />
          <input className="input" placeholder="Name" value={name} onChange={(e) => setName(e.target.value)} />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <input className="input" placeholder="Change notes" value={changeNotes} onChange={(e) => setChangeNotes(e.target.value)} />
          <input className="input font-mono" placeholder="Experiment ID (optional)" value={experimentId} onChange={(e) => setExperimentId(e.target.value)} />
        </div>
        <div>
          <label className="block text-xs uppercase tracking-wider text-text-muted mb-1">config_json</label>
          <LazyJsonEditor value={json} onChange={setJson} onValidate={setJsonOk} />
          {!jsonOk && <p className="text-xs text-danger mt-1">JSON has syntax errors — fix before saving.</p>}
        </div>
        <div className="flex justify-end gap-2 pt-3 border-t border-border">
          <button className="btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn-primary" disabled={!valid || save.isPending} onClick={() => save.mutate()}>
            {save.isPending ? 'Saving…' : isEdit ? 'Save draft' : 'Create draft'}
          </button>
        </div>
      </div>
    </Modal>
  );
}

// ── preview ────────────────────────────────────────────────────────────────

function PreviewModal({
  pageId, config, onClose,
}: {
  pageId: string;
  config: ConfigRecord;
  onClose: () => void;
}) {
  const [userId, setUserId] = useState('');
  const [lat, setLat] = useState('');
  const [lon, setLon] = useState('');

  const preview = useMutation({
    mutationFn: () =>
      sduiApi.preview(pageId, config.version, {
        env: ENV,
        user_id: userId || undefined,
        lat: lat ? Number(lat) : undefined,
        lon: lon ? Number(lon) : undefined,
      }),
  });

  return (
    <Modal open onClose={onClose} title={`Preview v${config.version}`} width="max-w-5xl">
      <div className="space-y-3">
        <div className="grid grid-cols-3 gap-3">
          <input className="input" placeholder="User ID (optional)" value={userId} onChange={(e) => setUserId(e.target.value)} />
          <input className="input" placeholder="Lat (optional)" value={lat} onChange={(e) => setLat(e.target.value)} />
          <input className="input" placeholder="Lon (optional)" value={lon} onChange={(e) => setLon(e.target.value)} />
        </div>
        <button className="btn-primary" disabled={preview.isPending} onClick={() => preview.mutate()}>
          {preview.isPending ? 'Hydrating…' : 'Run preview'}
        </button>
        {preview.data != null ? (
          <div className="flex items-start gap-4">
            <div className="shrink-0">
              <SduiVisualPreview page={preview.data} />
            </div>
            <div className="min-w-0 flex-1">
              <LazyJsonViewer value={JSON.stringify(preview.data, null, 2)} />
            </div>
          </div>
        ) : (
          <div className="rounded-xl border border-dashed border-border p-8 text-center text-sm text-text-muted">
            Run a preview to see the hydrated page — visual phone-frame mock and raw resolved JSON, side by side.
          </div>
        )}
      </div>
    </Modal>
  );
}

// ── audit log ──────────────────────────────────────────────────────────────

function AuditLogPanel({ pageId }: { pageId: string }) {
  const q = useQuery({ queryKey: sduiKeys.audit(pageId), queryFn: () => sduiApi.auditLog(pageId, 50) });

  return (
    <Card className="!p-0 overflow-hidden">
      <div className="px-4 py-3 border-b border-border text-sm font-medium">Audit log</div>
      <table className="w-full text-sm">
        <thead className="bg-surface-elevated text-text-muted text-xs uppercase tracking-wider">
          <tr>
            <th className="px-4 py-2 text-left">When</th>
            <th className="px-4 py-2 text-left">Action</th>
            <th className="px-4 py-2 text-left">Actor</th>
            <th className="px-4 py-2 text-left">Note</th>
          </tr>
        </thead>
        <tbody>
          {q.isLoading ? (
            [...Array(3)].map((_, i) => (
              <tr key={i} className="border-t border-border">
                {[...Array(4)].map((_, j) => (
                  <td key={j} className="px-4 py-2"><Skeleton className="h-4" /></td>
                ))}
              </tr>
            ))
          ) : (q.data?.length ?? 0) === 0 ? (
            <tr><td colSpan={4}><EmptyState title="No audit entries" /></td></tr>
          ) : (
            q.data?.map((e) => (
              <tr key={e.id} className="border-t border-border">
                <td className="px-4 py-2 text-text-secondary whitespace-nowrap">{new Date(e.created_at).toLocaleString()}</td>
                <td className="px-4 py-2"><StatusPill tone="neutral">{e.action}</StatusPill></td>
                <td className="px-4 py-2 font-mono text-xs text-text-secondary">{e.actor || '—'}</td>
                <td className="px-4 py-2 text-text-secondary">{e.note || '—'}</td>
              </tr>
            ))
          )}
        </tbody>
      </table>
    </Card>
  );
}
