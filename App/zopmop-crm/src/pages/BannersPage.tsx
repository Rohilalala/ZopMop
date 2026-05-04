import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowDown, ArrowUp, Plus, Trash2 } from 'lucide-react';

import { bannersApi, type Banner } from '@/api/all';
import { Card, EmptyState, Skeleton, StatusPill } from '@/components/ui';
import { ConfirmModal, Modal } from '@/components/ui/Modal';
import { showToast } from '@/components/ui/Toast';
import { Can } from '@/auth/Can';
import { usePermission } from '@/auth/usePermission';

export function BannersPage() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['banners'], queryFn: bannersApi.list });
  const [editing, setEditing] = useState<Banner | null>(null);
  const [creating, setCreating] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const canReorder = usePermission('banners.reorder');
  const canDelete  = usePermission('banners.delete');

  const reorder = useMutation({
    mutationFn: (ids: string[]) => bannersApi.reorder(ids),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['banners'] }); showToast({ kind: 'success', message: 'Order saved.' }); },
  });
  const del = useMutation({
    mutationFn: (id: string) => bannersApi.delete(id),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['banners'] }); showToast({ kind: 'success', message: 'Banner deleted.' }); setDeletingId(null); },
  });

  function move(idx: number, dir: -1 | 1) {
    if (!q.data) return;
    const next = [...q.data];
    const j = idx + dir;
    if (j < 0 || j >= next.length) return;
    [next[idx], next[j]] = [next[j], next[idx]];
    reorder.mutate(next.map((b) => b.id));
  }

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-end justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Home Banners</h1>
          <p className="text-sm text-text-secondary mt-1">Drag-friendly arrows reorder. Image hosted externally — paste URL.</p>
        </div>
        <Can perm="banners.create">
          <button className="btn-primary" onClick={() => setCreating(true)}><Plus className="w-4 h-4" />New banner</button>
        </Can>
      </div>

      {q.isLoading ? <Skeleton className="h-40" /> :
        (q.data?.length ?? 0) === 0 ? <Card><EmptyState title="No banners yet" /></Card> :
          <div className="space-y-3">
            {q.data?.map((b, i) => (
              <Card key={b.id} className="!p-4">
                <div className="flex gap-4 items-start">
                  <div className="w-32 h-20 rounded-xl overflow-hidden bg-surface-elevated border border-border shrink-0">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={b.image_url} alt={b.title} className="w-full h-full object-cover" onError={(e) => (e.currentTarget.style.display = 'none')} />
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <div className="font-semibold">{b.title}</div>
                      <StatusPill tone={b.is_active ? 'success' : 'neutral'}>{b.is_active ? 'active' : 'inactive'}</StatusPill>
                    </div>
                    {b.subtitle && <div className="text-sm text-text-secondary">{b.subtitle}</div>}
                    <div className="text-[11px] text-text-muted mt-1">audience: {b.audience} · order: {b.display_order}</div>
                  </div>
                  <div className="flex gap-1 shrink-0">
                    <button
                      className="btn-ghost !py-1 !px-2"
                      onClick={() => {
                        if (!canReorder) {
                          showToast({ kind: 'error', message: 'Insufficient permissions' });
                          return;
                        }
                        move(i, -1);
                      }}
                      disabled={i === 0 || !canReorder}
                      title={!canReorder ? 'Insufficient permissions' : undefined}
                    ><ArrowUp className="w-4 h-4" /></button>
                    <button
                      className="btn-ghost !py-1 !px-2"
                      onClick={() => {
                        if (!canReorder) {
                          showToast({ kind: 'error', message: 'Insufficient permissions' });
                          return;
                        }
                        move(i, 1);
                      }}
                      disabled={i === (q.data!.length - 1) || !canReorder}
                      title={!canReorder ? 'Insufficient permissions' : undefined}
                    ><ArrowDown className="w-4 h-4" /></button>
                    <button className="btn-ghost !py-1 !px-2" onClick={() => setEditing(b)}>Edit</button>
                    <button
                      className="btn-ghost text-danger !py-1 !px-2"
                      disabled={!canDelete}
                      title={!canDelete ? 'Insufficient permissions' : undefined}
                      onClick={() => {
                        if (!canDelete) {
                          showToast({ kind: 'error', message: 'Insufficient permissions' });
                          return;
                        }
                        setDeletingId(b.id);
                      }}
                    ><Trash2 className="w-4 h-4" /></button>
                  </div>
                </div>
              </Card>
            ))}
          </div>
      }

      {(creating || editing) && (
        <BannerEditor banner={editing} onClose={() => { setCreating(false); setEditing(null); }} />
      )}

      <ConfirmModal
        open={!!deletingId}
        onClose={() => setDeletingId(null)}
        onConfirm={() => del.mutateAsync(deletingId!)}
        title="Delete banner?"
        impact="Removes the row entirely. This cannot be undone."
        destructive
        confirmLabel="Delete"
      />
    </div>
  );
}

type Form = {
  title: string; subtitle: string; image_url: string;
  cta_label: string; cta_kind: string; tap_action: string;
  audience: string; is_active: boolean;
  display_order: number;
  starts_at: string; ends_at: string;
};

function emptyForm(b?: Banner | null): Form {
  return {
    title: b?.title ?? '',
    subtitle: b?.subtitle ?? '',
    image_url: b?.image_url ?? '',
    cta_label: b?.cta_label ?? '',
    cta_kind: b?.cta_kind ?? '',
    tap_action: b?.tap_action ?? '',
    audience: b?.audience ?? 'all',
    is_active: b?.is_active ?? true,
    display_order: b?.display_order ?? 0,
    starts_at: b?.starts_at?.slice(0, 16) ?? '',
    ends_at: b?.ends_at?.slice(0, 16) ?? '',
  };
}

function BannerEditor({ banner, onClose }: { banner: Banner | null; onClose: () => void }) {
  const qc = useQueryClient();
  const [f, setF] = useState<Form>(emptyForm(banner));
  const [confirm, setConfirm] = useState(false);
  const canCreate = usePermission('banners.create');
  const canUpdate = usePermission('banners.update');
  const canSave = banner ? canUpdate : canCreate;

  const save = useMutation({
    mutationFn: async () => {
      const body: Partial<Banner> = {
        ...f,
        starts_at: f.starts_at ? new Date(f.starts_at).toISOString() : null,
        ends_at: f.ends_at ? new Date(f.ends_at).toISOString() : null,
      };
      if (banner) await bannersApi.update(banner.id, body);
      else await bannersApi.create(body);
    },
    onSuccess: () => { showToast({ kind: 'success', message: banner ? 'Banner updated.' : 'Banner created.' }); qc.invalidateQueries({ queryKey: ['banners'] }); setConfirm(false); onClose(); },
  });

  return (
    <Modal open onClose={onClose} title={banner ? 'Edit banner' : 'New banner'} width="max-w-2xl">
      <div className="grid grid-cols-2 gap-4">
        <div className="space-y-3">
          <input className="input" placeholder="Title" value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} />
          <input className="input" placeholder="Subtitle" value={f.subtitle} onChange={(e) => setF({ ...f, subtitle: e.target.value })} />
          <input className="input" placeholder="Image URL (https://…)" value={f.image_url} onChange={(e) => setF({ ...f, image_url: e.target.value })} />
          <div className="grid grid-cols-2 gap-2">
            <input className="input" placeholder="CTA label" value={f.cta_label} onChange={(e) => setF({ ...f, cta_label: e.target.value })} />
            <select className="input" value={f.cta_kind} onChange={(e) => setF({ ...f, cta_kind: e.target.value })}>
              <option value="">— kind —</option>
              <option value="category">category</option>
              <option value="promo">promo</option>
              <option value="external">external</option>
              <option value="deeplink">deeplink</option>
            </select>
          </div>
          <input className="input" placeholder="Tap action (URL / promo code / route)" value={f.tap_action} onChange={(e) => setF({ ...f, tap_action: e.target.value })} />
          <select className="input" value={f.audience} onChange={(e) => setF({ ...f, audience: e.target.value })}>
            <option value="all">All users</option>
            <option value="new_users">New users</option>
            <option value="vip">VIP only</option>
            <option value="zone">By zone</option>
          </select>
          <div className="grid grid-cols-2 gap-2">
            <input className="input" type="datetime-local" value={f.starts_at} onChange={(e) => setF({ ...f, starts_at: e.target.value })} />
            <input className="input" type="datetime-local" value={f.ends_at} onChange={(e) => setF({ ...f, ends_at: e.target.value })} />
          </div>
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={f.is_active} onChange={(e) => setF({ ...f, is_active: e.target.checked })} /> Active</label>
        </div>
        <div>
          <div className="text-xs uppercase tracking-wider text-text-muted mb-2">Live preview</div>
          <div className="rounded-2xl overflow-hidden border border-border bg-surface-elevated">
            {f.image_url ? <img src={f.image_url} alt="preview" className="w-full h-32 object-cover" /> : <div className="w-full h-32 bg-surface" />}
            <div className="p-3">
              <div className="font-semibold text-sm">{f.title || 'Title'}</div>
              {f.subtitle && <div className="text-xs text-text-secondary">{f.subtitle}</div>}
              {f.cta_label && <button className="btn-primary mt-2 !py-1 text-xs">{f.cta_label}</button>}
            </div>
          </div>
        </div>
      </div>

      <div className="flex justify-end gap-2 mt-4 pt-3 border-t border-border">
        <button className="btn-ghost" onClick={onClose}>Cancel</button>
        <button
          className="btn-primary"
          onClick={() => {
            if (!canSave) {
              showToast({ kind: 'error', message: 'Insufficient permissions' });
              return;
            }
            setConfirm(true);
          }}
          disabled={!f.title || !f.image_url || !canSave}
          title={!canSave ? 'Insufficient permissions' : undefined}
        >Save</button>
      </div>

      <ConfirmModal
        open={confirm}
        onClose={() => setConfirm(false)}
        onConfirm={() => save.mutateAsync()}
        title={banner ? 'Save changes?' : 'Create banner?'}
        impact={`"${f.title}" will be ${f.is_active ? 'visible' : 'hidden'} on the home screen for ${f.audience}.`}
        confirmLabel={banner ? 'Save' : 'Create'}
      />
    </Modal>
  );
}
