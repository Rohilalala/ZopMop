import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Pause, Play, Plus, Square, Trophy } from 'lucide-react';

import { experimentsApi, type Experiment, type Variant } from '@/api/all';
import { Card, EmptyState, Skeleton, StatusPill } from '@/components/ui';
import { ConfirmModal, Modal } from '@/components/ui/Modal';
import { showToast } from '@/components/ui/Toast';

export function ExperimentsPage() {
  const q = useQuery({ queryKey: ['experiments'], queryFn: experimentsApi.list });
  const [creating, setCreating] = useState(false);
  return (
    <div className="p-6 space-y-6">
      <div className="flex items-end justify-between">
        <div>
          <h1 className="text-2xl font-semibold">A/B Tests</h1>
          <p className="text-sm text-text-secondary mt-1">Variants, traffic split, lifecycle.</p>
        </div>
        <button className="btn-primary" onClick={() => setCreating(true)}><Plus className="w-4 h-4" />New experiment</button>
      </div>

      {q.isLoading ? <Skeleton className="h-32" /> :
        (q.data?.length ?? 0) === 0 ? <Card><EmptyState title="No experiments yet" /></Card> :
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {q.data?.map((e) => <ExpCard key={e.id} exp={e} />)}
          </div>
      }
      {creating && <ExpEditor onClose={() => setCreating(false)} />}
    </div>
  );
}

function ExpCard({ exp }: { exp: Experiment }) {
  const qc = useQueryClient();
  const [pending, setPending] = useState<null | 'start' | 'pause' | 'stop' | 'rollout'>(null);
  const [winner, setWinner] = useState('');

  const m = useMutation({
    mutationFn: async () => {
      switch (pending) {
        case 'start': await experimentsApi.start(exp.id); break;
        case 'pause': await experimentsApi.pause(exp.id); break;
        case 'stop':  await experimentsApi.stop(exp.id);  break;
        case 'rollout': await experimentsApi.rollout(exp.id, winner); break;
      }
    },
    onSuccess: () => { showToast({ kind: 'success', message: 'Updated.' }); qc.invalidateQueries({ queryKey: ['experiments'] }); setPending(null); setWinner(''); },
  });

  return (
    <Card>
      <div className="flex items-start justify-between">
        <div>
          <h3 className="font-semibold">{exp.name}</h3>
          <div className="text-xs text-text-secondary">{exp.kind} → {exp.target_key ?? '—'} · metric: {exp.metric}</div>
        </div>
        <StatusPill tone={
          exp.status === 'running' ? 'success'
          : exp.status === 'paused' ? 'warning'
          : exp.status === 'rolled_out' ? 'info'
          : 'neutral'
        }>{exp.status}</StatusPill>
      </div>
      <div className="mt-3 space-y-1">
        {exp.variants.map((v) => (
          <div key={v.id} className="flex justify-between text-xs">
            <span className="text-text-secondary">{v.name}</span>
            <span className="font-mono">{v.traffic_pct}% · {JSON.stringify(v.value)}</span>
          </div>
        ))}
      </div>
      <div className="mt-3 pt-3 border-t border-border flex flex-wrap gap-2">
        {exp.status === 'draft'    && <button className="btn-ghost text-success !py-1" onClick={() => setPending('start')}><Play className="w-3.5 h-3.5" />Start</button>}
        {exp.status === 'running'  && <button className="btn-ghost text-warning !py-1" onClick={() => setPending('pause')}><Pause className="w-3.5 h-3.5" />Pause</button>}
        {exp.status === 'paused'   && <button className="btn-ghost text-success !py-1" onClick={() => setPending('start')}><Play className="w-3.5 h-3.5" />Resume</button>}
        {(exp.status === 'running' || exp.status === 'paused') && <button className="btn-ghost text-danger !py-1" onClick={() => setPending('stop')}><Square className="w-3.5 h-3.5" />Stop</button>}
        {exp.status === 'completed' && <button className="btn-ghost text-primary !py-1" onClick={() => setPending('rollout')}><Trophy className="w-3.5 h-3.5" />Roll out winner</button>}
      </div>

      <ConfirmModal
        open={pending === 'start' || pending === 'pause' || pending === 'stop'}
        onClose={() => setPending(null)}
        onConfirm={() => m.mutateAsync()}
        title={`${pending} experiment?`}
        impact={
          pending === 'stop' ? 'Stops traffic split immediately. Any unfinished sample is frozen.' :
          pending === 'pause' ? 'New users no longer get bucketed; existing assignments stay.' :
          'Bucketing starts immediately for matching audience.'
        }
        confirmLabel={pending ?? ''}
      />
      <ConfirmModal
        open={pending === 'rollout'}
        onClose={() => { setPending(null); setWinner(''); }}
        onConfirm={() => m.mutateAsync()}
        title="Roll out a winner?"
        impact={
          <div className="space-y-3">
            <p>Pick the winning variant. Its value will be applied to 100% of the audience for {exp.target_key ?? 'the target'}.</p>
            <select className="input" value={winner} onChange={(e) => setWinner(e.target.value)}>
              <option value="">— pick variant —</option>
              {exp.variants.map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}
            </select>
          </div>
        }
        confirmLabel="Roll out"
      />
    </Card>
  );
}

function ExpEditor({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const [name, setName] = useState('');
  const [hypothesis, setHypothesis] = useState('');
  const [kind, setKind] = useState<'flag' | 'banner' | 'promo' | 'ui'>('flag');
  const [targetKey, setTargetKey] = useState('');
  const [metric, setMetric] = useState('booking_conversion');
  const [audience, setAudience] = useState('all');
  const [variants, setVariants] = useState<Variant[]>([
    { id: 'control', name: 'Control', value: false, traffic_pct: 50 },
    { id: 'b',       name: 'B',       value: true,  traffic_pct: 50 },
  ]);
  const [confirm, setConfirm] = useState(false);

  const trafficSum = variants.reduce((s, v) => s + v.traffic_pct, 0);
  const valid = name && targetKey && trafficSum === 100 && variants.length >= 2;

  const create = useMutation({
    mutationFn: () => experimentsApi.create({ name, hypothesis, kind, target_key: targetKey, metric, audience, variants }),
    onSuccess: () => { showToast({ kind: 'success', message: 'Experiment created.' }); qc.invalidateQueries({ queryKey: ['experiments'] }); setConfirm(false); onClose(); },
  });

  return (
    <Modal open onClose={onClose} title="New experiment" width="max-w-xl">
      <div className="space-y-3">
        <input className="input" placeholder="Name" value={name} onChange={(e) => setName(e.target.value)} />
        <textarea className="input min-h-[60px]" placeholder="Hypothesis (optional)" value={hypothesis} onChange={(e) => setHypothesis(e.target.value)} />
        <div className="grid grid-cols-2 gap-3">
          <select className="input" value={kind} onChange={(e) => setKind(e.target.value as typeof kind)}>
            <option value="flag">Flag</option><option value="banner">Banner</option>
            <option value="promo">Promo</option><option value="ui">UI</option>
          </select>
          <input className="input" placeholder="Target (flag key / banner id / etc)" value={targetKey} onChange={(e) => setTargetKey(e.target.value)} />
          <input className="input" placeholder="Metric" value={metric} onChange={(e) => setMetric(e.target.value)} />
          <select className="input" value={audience} onChange={(e) => setAudience(e.target.value)}>
            <option value="all">All</option><option value="new_users">New users</option><option value="vip">VIP</option>
          </select>
        </div>
        <div>
          <div className="text-xs uppercase tracking-wider text-text-muted mb-2">Variants ({trafficSum}% allocated — must equal 100)</div>
          <div className="space-y-2">
            {variants.map((v, i) => (
              <div key={v.id} className="grid grid-cols-[1fr_2fr_80px] gap-2">
                <input className="input" value={v.name} onChange={(e) => setVariants(variants.map((x, j) => j === i ? { ...x, name: e.target.value } : x))} />
                <input className="input font-mono" value={String(v.value)} onChange={(e) => setVariants(variants.map((x, j) => j === i ? { ...x, value: parseValue(e.target.value) } : x))} />
                <input className="input" type="number" value={v.traffic_pct} onChange={(e) => setVariants(variants.map((x, j) => j === i ? { ...x, traffic_pct: Number(e.target.value) } : x))} />
              </div>
            ))}
          </div>
          <button className="btn-ghost text-xs mt-2" onClick={() => setVariants([...variants, { id: `v${variants.length}`, name: '', value: '', traffic_pct: 0 }])}>+ Add variant</button>
        </div>

        <div className="flex justify-end gap-2 pt-3 border-t border-border">
          <button className="btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn-primary" disabled={!valid} onClick={() => setConfirm(true)}>Create</button>
        </div>
      </div>

      <ConfirmModal
        open={confirm}
        onClose={() => setConfirm(false)}
        onConfirm={() => create.mutateAsync()}
        title="Create experiment?"
        impact={`"${name}" will be created in draft state — start it manually when ready.`}
        confirmLabel="Create"
      />
    </Modal>
  );
}

function parseValue(s: string): unknown {
  if (s === 'true') return true;
  if (s === 'false') return false;
  if (s === 'null') return null;
  const n = Number(s);
  if (!isNaN(n) && s !== '') return n;
  try { return JSON.parse(s); } catch { return s; }
}
