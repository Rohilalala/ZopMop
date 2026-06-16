// CatalogPage — edit service prices, MRP, and the active flag. The customer app
// reads the same service_categories table via GET /services with no cache, so an
// edit here shows up in the app on its next load / pull-to-refresh.
// Backend: internal/crm/catalog/catalog.go (reuses internal/services).

import { useEffect, useState } from 'react';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Pencil } from 'lucide-react';

import {
  listCatalog,
  updateCatalogService,
  type CatalogService,
  type CatalogUpdate,
} from '@/api/catalog';
import { Card, EmptyState, Skeleton } from '@/components/ui';
import { Modal } from '@/components/ui/Modal';
import { showToast } from '@/components/ui/Toast';
import { usePermission } from '@/auth/usePermission';

// Paise → "₹125" / "₹25.50". Money is integer paise end-to-end; only divide for
// display, never store the float.
function rupees(paise?: number): string {
  if (paise == null) return '—';
  const r = paise / 100;
  return '₹' + (Number.isInteger(r) ? r.toLocaleString('en-IN') : r.toFixed(2));
}

export function CatalogPage() {
  const qc = useQueryClient();
  const canEdit = usePermission('catalog.update');
  const [editing, setEditing] = useState<CatalogService | null>(null);

  const q = useQuery({
    queryKey: ['catalog'],
    queryFn: listCatalog,
    placeholderData: keepPreviousData,
  });

  const save = useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: CatalogUpdate }) => updateCatalogService(id, patch),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['catalog'] });
      setEditing(null);
      showToast({ kind: 'success', message: 'Saved — live in the app on next refresh' });
    },
    onError: (e: any) => showToast({ kind: 'error', message: e?.response?.data?.error ?? 'Could not save' }),
  });

  const toggleActive = useMutation({
    mutationFn: (s: CatalogService) => updateCatalogService(s.id, { is_active: !s.is_active }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['catalog'] }),
    onError: (e: any) => showToast({ kind: 'error', message: e?.response?.data?.error ?? 'Could not update' }),
  });

  const rows = q.data ?? [];

  return (
    <div className="p-6 space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Catalog</h1>
        <p className="text-sm text-text-secondary mt-1">
          Service prices, MRP, and availability. Edits here go live in the customer
          app on its next load — there's no separate publish step.
          {!canEdit && ' You have read-only access.'}
        </p>
      </div>

      <Card className="!p-0 overflow-hidden">
        {q.isLoading ? (
          <div className="p-6 space-y-3">
            {Array.from({ length: 6 }).map((_, i) => (
              <Skeleton key={i} className="h-10" />
            ))}
          </div>
        ) : rows.length === 0 ? (
          <EmptyState title="No services" body="The catalog is empty." />
        ) : (
          <table className="w-full text-sm">
            <thead className="bg-surface-elevated text-text-muted text-xs uppercase tracking-wider">
              <tr>
                <th className="px-4 py-3 text-left">Service</th>
                <th className="px-4 py-3 text-left">Category</th>
                <th className="px-4 py-3 text-right">Price (30 min)</th>
                <th className="px-4 py-3 text-right">MRP</th>
                <th className="px-4 py-3 text-left">Active</th>
                {canEdit && <th className="px-4 py-3 text-right w-24">Edit</th>}
              </tr>
            </thead>
            <tbody>
              {rows.map((s) => (
                <tr key={s.id} className="border-t border-border-subtle hover:bg-surface-elevated/40">
                  <td className="px-4 py-3 font-medium">{s.name}</td>
                  <td className="px-4 py-3 text-text-secondary">{s.category}</td>
                  <td className="px-4 py-3 text-right tabular-nums">{rupees(s.base_price_paise)}</td>
                  <td className="px-4 py-3 text-right tabular-nums text-text-muted">{rupees(s.mrp_paise)}</td>
                  <td className="px-4 py-3">
                    <button
                      onClick={() => canEdit && toggleActive.mutate(s)}
                      className={`px-2 py-0.5 rounded text-xs font-semibold ${
                        s.is_active
                          ? 'bg-emerald-500/15 text-emerald-400'
                          : 'bg-zinc-700/40 text-text-muted'
                      } ${canEdit ? 'cursor-pointer' : 'cursor-default'}`}
                      disabled={!canEdit || toggleActive.isPending}
                    >
                      {s.is_active ? 'Active' : 'Disabled'}
                    </button>
                  </td>
                  {canEdit && (
                    <td className="px-4 py-3 text-right">
                      <button
                        className="text-primary hover:text-primary/80 inline-flex items-center gap-1"
                        onClick={() => setEditing(s)}
                      >
                        <Pencil className="w-3.5 h-3.5" />
                        Edit
                      </button>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>

      <EditModal
        service={editing}
        onClose={() => setEditing(null)}
        onSave={(id, patch) => save.mutate({ id, patch })}
        saving={save.isPending}
      />
    </div>
  );
}

// Single page-level edit modal (rendered outside the table to avoid a
// <div>-inside-<tbody> DOM-nesting warning). Inputs are in rupees; converted to
// integer paise on save.
function EditModal({
  service,
  onClose,
  onSave,
  saving,
}: {
  service: CatalogService | null;
  onClose: () => void;
  onSave: (id: string, patch: CatalogUpdate) => void;
  saving: boolean;
}) {
  const [priceR, setPriceR] = useState('');
  const [mrpR, setMrpR] = useState('');
  const [active, setActive] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!service) return;
    setPriceR(String(service.base_price_paise / 100));
    setMrpR(service.mrp_paise ? String(service.mrp_paise / 100) : '');
    setActive(service.is_active);
    setError('');
  }, [service]);

  function submit() {
    if (!service) return;
    const price = Math.round(parseFloat(priceR) * 100);
    if (!Number.isFinite(price) || price <= 0) {
      setError('Price must be greater than ₹0');
      return;
    }
    const patch: CatalogUpdate = { base_price_paise: price, is_active: active };
    if (mrpR.trim()) {
      const mrp = Math.round(parseFloat(mrpR) * 100);
      if (!Number.isFinite(mrp) || mrp <= 0) {
        setError('MRP must be greater than ₹0');
        return;
      }
      if (mrp < price) {
        setError('MRP must be greater than or equal to price');
        return;
      }
      patch.mrp_paise = mrp;
    }
    onSave(service.id, patch);
  }

  return (
    <Modal open={!!service} onClose={onClose} title={service ? `Edit — ${service.name}` : ''}>
      <div className="space-y-4">
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="text-xs text-text-muted block mb-1">Price (30 min) ₹</label>
            <input
              className="input w-full tabular-nums"
              type="number"
              min={1}
              step="1"
              value={priceR}
              onChange={(e) => setPriceR(e.target.value)}
            />
          </div>
          <div>
            <label className="text-xs text-text-muted block mb-1">MRP ₹ (optional)</label>
            <input
              className="input w-full tabular-nums"
              type="number"
              min={1}
              step="1"
              value={mrpR}
              placeholder="strike-through"
              onChange={(e) => setMrpR(e.target.value)}
            />
          </div>
        </div>

        <label className="flex items-center gap-2 cursor-pointer select-none">
          <input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} />
          <span className="text-sm">Active (visible &amp; bookable in the app)</span>
        </label>

        <p className="text-xs text-text-muted">
          60 / 90-min prices scale automatically from the 30-min price. Money is in
          whole rupees; saved as integer paise.
        </p>

        {error && <div className="text-sm text-rose-400">{error}</div>}

        <div className="flex justify-end gap-2 pt-2">
          <button className="btn-ghost" onClick={onClose} disabled={saving}>Cancel</button>
          <button className="btn-primary" onClick={submit} disabled={saving}>
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
    </Modal>
  );
}
