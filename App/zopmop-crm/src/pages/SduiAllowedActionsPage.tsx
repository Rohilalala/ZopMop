import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, Trash2 } from 'lucide-react';

import { sduiApi, sduiKeys, type AllowedAction } from '@/api/sdui';
import { Card, EmptyState, Skeleton, StatusPill } from '@/components/ui';
import { ConfirmModal, Modal } from '@/components/ui/Modal';
import { showToast } from '@/components/ui/Toast';
import { Can } from '@/auth/Can';
import { usePermission } from '@/auth/usePermission';

const HTTP_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const;

// SDUI action allowlist. Configs can only reference endpoints/methods present
// here — this page is the gate operators use to widen what SDUI buttons may
// call. Add and delete only; entries are immutable once created.
export function SduiAllowedActionsPage() {
  const qc = useQueryClient();
  const [adding, setAdding] = useState(false);
  const [toDelete, setToDelete] = useState<AllowedAction | null>(null);
  const canWrite = usePermission('sdui.write');

  const q = useQuery({ queryKey: sduiKeys.allowed, queryFn: sduiApi.listAllowed });

  const del = useMutation({
    mutationFn: (id: string) => sduiApi.deleteAllowed(id),
    onSuccess: () => {
      showToast({ kind: 'success', message: 'Allowed action removed.' });
      qc.invalidateQueries({ queryKey: sduiKeys.allowed });
      setToDelete(null);
    },
  });

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-end justify-between">
        <div>
          <h1 className="text-2xl font-semibold">SDUI Action allowlist</h1>
          <p className="text-sm text-text-secondary mt-1">
            Endpoints + methods that SDUI button actions are permitted to call.
          </p>
        </div>
        <Can perm="sdui.write">
          <button className="btn-primary" onClick={() => setAdding(true)}>
            <Plus className="w-4 h-4" />Add action
          </button>
        </Can>
      </div>

      <Card className="!p-0 overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-surface-elevated text-text-muted text-xs uppercase tracking-wider">
            <tr>
              <th className="px-4 py-3 text-left">Endpoint</th>
              <th className="px-4 py-3 text-left">Methods</th>
              <th className="px-4 py-3 text-left">Status</th>
              <th className="px-4 py-3 text-right w-12" />
            </tr>
          </thead>
          <tbody>
            {q.isLoading ? (
              [...Array(4)].map((_, i) => (
                <tr key={i} className="border-t border-border">
                  {[...Array(4)].map((_, j) => (
                    <td key={j} className="px-4 py-3"><Skeleton className="h-4" /></td>
                  ))}
                </tr>
              ))
            ) : (q.data?.length ?? 0) === 0 ? (
              <tr><td colSpan={4}><EmptyState title="No allowed actions" body="SDUI buttons can't call any endpoint until one is added." /></td></tr>
            ) : (
              q.data?.map((a) => (
                <tr key={a.id} className="border-t border-border">
                  <td className="px-4 py-3 font-mono">{a.endpoint}</td>
                  <td className="px-4 py-3">
                    <div className="flex flex-wrap gap-1">
                      {a.methods.map((m) => (
                        <span key={m} className="pill border-border text-text-secondary bg-surface-elevated">{m}</span>
                      ))}
                    </div>
                  </td>
                  <td className="px-4 py-3">
                    <StatusPill tone={a.is_active ? 'success' : 'neutral'}>{a.is_active ? 'active' : 'inactive'}</StatusPill>
                  </td>
                  <td className="px-4 py-3 text-right">
                    <button
                      className="btn-ghost text-danger"
                      disabled={!canWrite}
                      title={!canWrite ? 'Insufficient permissions' : 'Delete'}
                      onClick={() => {
                        if (!canWrite) { showToast({ kind: 'error', message: 'Insufficient permissions' }); return; }
                        setToDelete(a);
                      }}
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </Card>

      {adding && <AddActionModal onClose={() => setAdding(false)} />}

      <ConfirmModal
        open={!!toDelete}
        onClose={() => setToDelete(null)}
        onConfirm={() => del.mutateAsync(toDelete!.id)}
        title="Remove allowed action?"
        destructive
        impact={
          <span>
            SDUI buttons will no longer be able to call{' '}
            <code className="font-mono">{toDelete?.endpoint}</code>. Existing configs that reference it will fail validation.
          </span>
        }
        confirmLabel="Remove"
      />
    </div>
  );
}

function AddActionModal({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const [endpoint, setEndpoint] = useState('');
  const [methods, setMethods] = useState<string[]>(['POST']);

  const create = useMutation({
    mutationFn: () => sduiApi.createAllowed({ endpoint: endpoint.trim(), methods }),
    onSuccess: () => {
      showToast({ kind: 'success', message: 'Allowed action added.' });
      qc.invalidateQueries({ queryKey: sduiKeys.allowed });
      onClose();
    },
  });

  const toggleMethod = (m: string) =>
    setMethods((prev) => (prev.includes(m) ? prev.filter((x) => x !== m) : [...prev, m]));

  const valid = endpoint.trim().length > 0 && methods.length > 0;

  return (
    <Modal open onClose={onClose} title="Add allowed action" width="max-w-lg">
      <div className="space-y-4">
        <div>
          <label className="block text-xs uppercase tracking-wider text-text-muted mb-1">Endpoint</label>
          <input
            className="input font-mono"
            placeholder="/api/v1/cart/add"
            value={endpoint}
            onChange={(e) => setEndpoint(e.target.value)}
          />
        </div>
        <div>
          <label className="block text-xs uppercase tracking-wider text-text-muted mb-2">Methods</label>
          <div className="flex flex-wrap gap-2">
            {HTTP_METHODS.map((m) => (
              <label key={m} className="flex items-center gap-1.5 text-sm cursor-pointer">
                <input type="checkbox" checked={methods.includes(m)} onChange={() => toggleMethod(m)} />
                {m}
              </label>
            ))}
          </div>
        </div>
        <div className="flex justify-end gap-2 pt-3 border-t border-border">
          <button className="btn-ghost" onClick={onClose}>Cancel</button>
          <button
            className="btn-primary"
            disabled={!valid || create.isPending}
            onClick={() => create.mutate()}
          >
            {create.isPending ? 'Adding…' : 'Add'}
          </button>
        </div>
      </div>
    </Modal>
  );
}
