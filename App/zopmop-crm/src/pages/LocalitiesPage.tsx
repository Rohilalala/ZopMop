// LocalitiesPage — minimal CRUD for the operational areas every helper picks
// from. The pro app reads the active subset via the public /localities
// endpoint; bookings snapshot a locality at create time. Backend:
// internal/crm/localities/localities.go.

import { useState } from 'react';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, Trash2 } from 'lucide-react';

import {
  createLocality,
  deleteLocality,
  listLocalities,
  updateLocality,
  type Locality,
} from '@/api/localities';
import { Card, EmptyState, Skeleton } from '@/components/ui';
import { ConfirmModal } from '@/components/ui/Modal';
import { showToast } from '@/components/ui/Toast';

export function LocalitiesPage() {
  const qc = useQueryClient();
  const [name, setName] = useState('');
  const [city, setCity] = useState('Gurugram');
  const [confirmDel, setConfirmDel] = useState<Locality | null>(null);

  const q = useQuery({
    queryKey: ['localities'],
    queryFn: () => listLocalities(),
    placeholderData: keepPreviousData,
  });

  const create = useMutation({
    mutationFn: () => createLocality(name.trim(), city.trim()),
    onSuccess: () => {
      setName('');
      qc.invalidateQueries({ queryKey: ['localities'] });
      showToast({ kind: 'success', message: 'Locality added' });
    },
    onError: (e: any) => showToast({ kind: 'error', message: e?.response?.data?.error ?? 'Could not add' }),
  });

  const toggle = useMutation({
    mutationFn: (l: Locality) =>
      updateLocality(l.id, { name: l.name, city: l.city, active: !l.active }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['localities'] });
    },
    onError: (e: any) => showToast({ kind: 'error', message: e?.response?.data?.error ?? 'Could not update' }),
  });

  const del = useMutation({
    mutationFn: (l: Locality) => deleteLocality(l.id),
    onSuccess: () => {
      setConfirmDel(null);
      qc.invalidateQueries({ queryKey: ['localities'] });
      showToast({ kind: 'success', message: 'Locality removed' });
    },
    onError: (e: any) => showToast({ kind: 'error', message: e?.response?.data?.error ?? 'Could not remove' }),
  });

  function submitNew(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim() || !city.trim()) return;
    create.mutate();
  }

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-end justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Localities</h1>
          <p className="text-sm text-text-secondary mt-1">
            Operational areas. Helpers pick one from this list; bookings
            snapshot a match at create time.
          </p>
        </div>
      </div>

      <Card className="!p-4">
        <form onSubmit={submitNew} className="flex gap-3 items-end flex-wrap">
          <div className="flex-1 min-w-[180px]">
            <label className="text-xs text-text-muted block mb-1">Name</label>
            <input
              className="input w-full"
              placeholder="e.g. Sector 14"
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={100}
            />
          </div>
          <div className="w-[180px]">
            <label className="text-xs text-text-muted block mb-1">City</label>
            <input
              className="input w-full"
              placeholder="e.g. Gurugram"
              value={city}
              onChange={(e) => setCity(e.target.value)}
              maxLength={80}
            />
          </div>
          <button
            type="submit"
            className="btn-primary"
            disabled={!name.trim() || !city.trim() || create.isPending}
          >
            <Plus className="w-4 h-4" />
            {create.isPending ? 'Adding…' : 'Add'}
          </button>
        </form>
      </Card>

      <Card className="!p-0 overflow-hidden">
        {q.isLoading ? (
          <div className="p-6 space-y-3">
            {Array.from({ length: 5 }).map((_, i) => (
              <Skeleton key={i} className="h-10" />
            ))}
          </div>
        ) : (q.data ?? []).length === 0 ? (
          <EmptyState title="No localities yet" body="Add one above to get started." />
        ) : (
          <table className="w-full text-sm">
            <thead className="bg-surface-elevated text-text-muted text-xs uppercase tracking-wider">
              <tr>
                <th className="px-4 py-3 text-left">Name</th>
                <th className="px-4 py-3 text-left">City</th>
                <th className="px-4 py-3 text-left">Active</th>
                <th className="px-4 py-3 text-left">Created</th>
                <th className="px-4 py-3 text-right w-32">Actions</th>
              </tr>
            </thead>
            <tbody>
              {(q.data ?? []).map((l) => (
                <tr key={l.id} className="border-t border-border-subtle hover:bg-surface-elevated/40">
                  <td className="px-4 py-3 font-medium">{l.name}</td>
                  <td className="px-4 py-3 text-text-secondary">{l.city}</td>
                  <td className="px-4 py-3">
                    <button
                      onClick={() => toggle.mutate(l)}
                      className={`px-2 py-0.5 rounded text-xs font-semibold ${
                        l.active
                          ? 'bg-emerald-500/15 text-emerald-400'
                          : 'bg-zinc-700/40 text-text-muted'
                      }`}
                      disabled={toggle.isPending}
                    >
                      {l.active ? 'Active' : 'Disabled'}
                    </button>
                  </td>
                  <td className="px-4 py-3 text-xs text-text-muted">
                    {new Date(l.created_at).toLocaleDateString()}
                  </td>
                  <td className="px-4 py-3 text-right">
                    <button
                      className="text-rose-400 hover:text-rose-300 inline-flex items-center gap-1"
                      onClick={() => setConfirmDel(l)}
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                      Delete
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>

      <ConfirmModal
        open={!!confirmDel}
        title="Delete locality?"
        impact={
          <>
            <strong>{confirmDel?.name}</strong> will no longer be selectable by
            helpers. Existing bookings keep their snapshot.
          </>
        }
        confirmLabel="Delete"
        destructive
        onConfirm={async () => {
          if (confirmDel) {
            await del.mutateAsync(confirmDel);
          }
        }}
        onClose={() => setConfirmDel(null)}
      />
    </div>
  );
}
