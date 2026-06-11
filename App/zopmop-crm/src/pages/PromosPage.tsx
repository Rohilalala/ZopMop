import { useState } from 'react';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, Wand2 } from 'lucide-react';

import { promosApi, type Promo } from '@/api/all';
import { utcToISTInput, istInputToUTC } from '@/lib/formatters';
import { Card, EmptyState, Skeleton, StatusPill } from '@/components/ui';
import { ConfirmModal, Modal } from '@/components/ui/Modal';
import { showToast } from '@/components/ui/Toast';
import { Can } from '@/auth/Can';
import { usePermission } from '@/auth/usePermission';

const fmt = (c: number) => '₹' + (c / 100).toLocaleString('en-IN', { maximumFractionDigits: 0 });

export function PromosPage() {
  const [params, setParams] = useState({ status: '', search: '', limit: 50, offset: 0 });
  const [editing, setEditing] = useState<Promo | null>(null);
  const [creating, setCreating] = useState(false);

  const q = useQuery({
    queryKey: ['promos', params],
    queryFn: () => promosApi.list(params),
    placeholderData: keepPreviousData,
  });

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-end justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Promos</h1>
          <p className="text-sm text-text-secondary mt-1">Discount codes, campaign tracking.</p>
        </div>
        <Can perm="promos.create">
          <button className="btn-primary" onClick={() => setCreating(true)}><Plus className="w-4 h-4" />New promo</button>
        </Can>
      </div>

      <Card className="!p-4">
        <div className="flex gap-3">
          <input className="input flex-1" placeholder="Search code…" value={params.search} onChange={(e) => setParams((p) => ({ ...p, search: e.target.value, offset: 0 }))} />
          <select className="input max-w-[180px]" value={params.status} onChange={(e) => setParams((p) => ({ ...p, status: e.target.value, offset: 0 }))}>
            <option value="">All</option><option value="active">Active</option><option value="inactive">Inactive</option><option value="expired">Expired</option>
          </select>
        </div>
      </Card>

      <Card className="!p-0 overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-surface-elevated text-text-muted text-xs uppercase tracking-wider">
            <tr>
              <th className="px-4 py-3 text-left">Code</th>
              <th className="px-4 py-3 text-left">Discount</th>
              <th className="px-4 py-3 text-right">Used</th>
              <th className="px-4 py-3 text-left">Expires</th>
              <th className="px-4 py-3 text-left">Status</th>
            </tr>
          </thead>
          <tbody>
            {q.isLoading ? [...Array(5)].map((_, i) => (
              <tr key={i} className="border-t border-border">{[...Array(5)].map((_, j) => <td key={j} className="px-4 py-3"><Skeleton className="h-4" /></td>)}</tr>
            )) : (q.data?.items.length ?? 0) === 0 ? (
              <tr><td colSpan={5}><EmptyState title="No promos" /></td></tr>
            ) : q.data?.items.map((p) => (
              <tr key={p.id} className="border-t border-border cursor-pointer hover:bg-primary/5" onClick={() => setEditing(p)}>
                <td className="px-4 py-3 font-mono">{p.code}</td>
                <td className="px-4 py-3">{p.discount_type === 'percent' ? `${p.discount_value}%` : fmt(p.discount_value)}</td>
                <td className="px-4 py-3 text-right tabular-nums">{p.uses_count}{p.max_uses > 0 && <span className="text-text-muted"> / {p.max_uses}</span>}</td>
                <td className="px-4 py-3 text-text-secondary">{p.expires_at ? new Date(p.expires_at).toLocaleDateString() : '—'}</td>
                <td className="px-4 py-3">
                  <StatusPill tone={p.is_active ? 'success' : 'neutral'}>{p.is_active ? 'active' : 'inactive'}</StatusPill>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>

      {(creating || editing) && (
        <PromoEditor
          promo={editing}
          onClose={() => { setCreating(false); setEditing(null); }}
        />
      )}
    </div>
  );
}

type Form = {
  code: string; name: string; description: string;
  discount_type: 'percent' | 'fixed';
  discount_value: number; min_order_paise: number;
  max_uses: number; max_per_user: number;
  is_active: boolean; stackable: boolean;
  audience: string;
  starts_at: string; expires_at: string;
};

function emptyForm(p?: Promo | null): Form {
  return {
    code: p?.code ?? '',
    name: p?.name ?? '',
    description: p?.description ?? '',
    discount_type: (p?.discount_type as Form['discount_type']) ?? 'percent',
    discount_value: p?.discount_value ?? 10,
    min_order_paise: p?.min_order_paise ?? 0,
    max_uses: p?.max_uses ?? 0,
    max_per_user: p?.max_per_user ?? 1,
    is_active: p?.is_active ?? true,
    stackable: p?.stackable ?? false,
    audience: p?.audience ?? 'all',
    starts_at: utcToISTInput(p?.starts_at),
    expires_at: utcToISTInput(p?.expires_at),
  };
}

function PromoEditor({ promo, onClose }: { promo: Promo | null; onClose: () => void }) {
  const qc = useQueryClient();
  const [f, setF] = useState<Form>(emptyForm(promo));
  const [confirm, setConfirm] = useState(false);
  const [toggleConfirm, setToggleConfirm] = useState(false);

  const save = useMutation({
    mutationFn: async () => {
      const body: Partial<Promo> = {
        ...f,
        starts_at: istInputToUTC(f.starts_at),
        expires_at: istInputToUTC(f.expires_at),
        // The editor form has no UI for these two targeting arrays, but the
        // backend Update overwrites the columns with whatever the body carries
        // (absent → empty arrays). Echo the existing values back so an edit of
        // any other field doesn't silently wipe audience targeting / categories.
        audience_user_ids: promo?.audience_user_ids ?? [],
        categories: promo?.categories ?? [],
      };
      if (promo) await promosApi.update(promo.id, body);
      else await promosApi.create(body);
    },
    onSuccess: () => { showToast({ kind: 'success', message: promo ? 'Promo updated.' : 'Promo created.' }); qc.invalidateQueries({ queryKey: ['promos'] }); setConfirm(false); onClose(); },
  });

  const toggle = useMutation({
    mutationFn: () => promo!.is_active ? promosApi.deactivate(promo!.id) : promosApi.activate(promo!.id),
    onSuccess: () => { showToast({ kind: 'success', message: 'Status updated.' }); qc.invalidateQueries({ queryKey: ['promos'] }); setToggleConfirm(false); onClose(); },
  });

  async function genCode() {
    const code = await promosApi.generateCode();
    setF((x) => ({ ...x, code }));
  }

  const canCreate = usePermission('promos.create');
  const canUpdate = usePermission('promos.update');
  const canToggle = usePermission('promos.toggle');
  const canSave = promo ? canUpdate : canCreate;

  return (
    <Modal open onClose={onClose} title={promo ? `Edit ${promo.code}` : 'Create promo'} width="max-w-2xl">
      <div className="space-y-3">
        <div className="flex gap-2">
          <input className="input font-mono" placeholder="CODE" value={f.code} onChange={(e) => setF({ ...f, code: e.target.value.toUpperCase() })} />
          <button className="btn-ghost" onClick={genCode}><Wand2 className="w-4 h-4" />Generate</button>
        </div>
        <input className="input" placeholder="Internal name" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />
        <textarea className="input min-h-[60px]" placeholder="Description (shown to user)" value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} />
        <div className="grid grid-cols-2 gap-3">
          <select className="input" value={f.discount_type} onChange={(e) => setF({ ...f, discount_type: e.target.value as Form['discount_type'] })}>
            <option value="percent">Percent (%)</option>
            <option value="fixed">Fixed (paise)</option>
          </select>
          <input
            className="input"
            type="number"
            placeholder={f.discount_type === 'percent' ? 'Value (1–100)' : 'Value (paise, max 1,000,000)'}
            min={1}
            max={f.discount_type === 'percent' ? 100 : 1000000}
            value={f.discount_value || ''}
            onChange={(e) => setF({ ...f, discount_value: Number(e.target.value) })}
          />
          <input className="input" type="number" placeholder="Min order (₹ × 100)" value={f.min_order_paise || ''} onChange={(e) => setF({ ...f, min_order_paise: Number(e.target.value) })} />
          <input className="input" type="number" placeholder="Max total uses (0 = ∞)" value={f.max_uses || ''} onChange={(e) => setF({ ...f, max_uses: Number(e.target.value) })} />
          <input className="input" type="number" placeholder="Max per user" value={f.max_per_user || ''} onChange={(e) => setF({ ...f, max_per_user: Number(e.target.value) })} />
          <select className="input" value={f.audience} onChange={(e) => setF({ ...f, audience: e.target.value })}>
            <option value="all">All users</option>
            <option value="new_users">New users</option>
            <option value="vip">VIP only</option>
            <option value="specific">Specific users</option>
          </select>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <label className="text-xs text-text-muted">Starts at<input className="input mt-1" type="datetime-local" value={f.starts_at} onChange={(e) => setF({ ...f, starts_at: e.target.value })} /></label>
          <label className="text-xs text-text-muted">Expires at<input className="input mt-1" type="datetime-local" value={f.expires_at} onChange={(e) => setF({ ...f, expires_at: e.target.value })} /></label>
        </div>
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={f.stackable} onChange={(e) => setF({ ...f, stackable: e.target.checked })} /> Stackable with other promos</label>
        <div className="flex justify-between pt-3 border-t border-border">
          {promo ? (
            <button
              className="btn-ghost text-warning"
              disabled={!canToggle}
              title={!canToggle ? 'Insufficient permissions' : undefined}
              onClick={() => {
                if (!canToggle) {
                  showToast({ kind: 'error', message: 'Insufficient permissions' });
                  return;
                }
                setToggleConfirm(true);
              }}
            >
              {promo.is_active ? 'Deactivate' : 'Activate'}
            </button>
          ) : <span />}
          <div className="flex gap-2">
            <button className="btn-ghost" onClick={onClose}>Cancel</button>
            <button
              className="btn-primary"
              disabled={!canSave}
              title={!canSave ? 'Insufficient permissions' : undefined}
              onClick={() => {
                if (!canSave) {
                  showToast({ kind: 'error', message: 'Insufficient permissions' });
                  return;
                }
                setConfirm(true);
              }}
            >Save</button>
          </div>
        </div>
      </div>

      <ConfirmModal
        open={confirm}
        onClose={() => setConfirm(false)}
        onConfirm={() => save.mutateAsync()}
        title={promo ? 'Save changes?' : 'Create promo?'}
        impact={
          <div className="space-y-2">
            <p>Code: <code className="font-mono">{f.code}</code></p>
            <p>Discount: {f.discount_type === 'percent' ? `${f.discount_value}%` : fmt(f.discount_value)}</p>
            <p>Audience: {f.audience}</p>
            <p>Expires: {f.expires_at || 'never'}</p>
          </div>
        }
        confirmLabel={promo ? 'Save' : 'Create'}
      />
      <ConfirmModal
        open={toggleConfirm}
        onClose={() => setToggleConfirm(false)}
        onConfirm={() => toggle.mutateAsync()}
        title={promo?.is_active ? 'Deactivate promo?' : 'Activate promo?'}
        impact={promo?.is_active
          ? `Code "${promo?.code}" will stop working immediately. Past orders are unaffected.`
          : `Code "${promo?.code}" will start working immediately.`}
        confirmLabel={promo?.is_active ? 'Deactivate' : 'Activate'}
      />
    </Modal>
  );
}
