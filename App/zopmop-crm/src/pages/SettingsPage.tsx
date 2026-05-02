import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { growthApi, zonesApi, platformApi, tsApi, type Zone } from '@/api/all';
import { Card, EmptyState, Skeleton, StatusPill } from '@/components/ui';
import { ConfirmModal, Modal } from '@/components/ui/Modal';
import { showToast } from '@/components/ui/Toast';

// SettingsPage: hub for the smaller config-y modules — loyalty config, zones,
// surge, app version, changelog, response templates, audit log viewer.
// Each section is collapsible-ish (accordion via simple heading).

const TABS = [
  'loyalty', 'zones', 'surge', 'webhooks', 'templates',
  'app-version', 'changelog', 'audit', 'blacklist',
] as const;
type Tab = typeof TABS[number];

export function SettingsPage() {
  const [tab, setTab] = useState<Tab>('loyalty');
  return (
    <div className="p-6 space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Settings</h1>
        <p className="text-sm text-text-secondary mt-1">Loyalty, zones, surge, webhooks, templates, app version, changelog, audit log, blacklist.</p>
      </div>
      <div className="flex gap-1 border-b border-border overflow-x-auto">
        {TABS.map((t) => (
          <button key={t} onClick={() => setTab(t)} className={`px-4 py-2 text-sm capitalize border-b-2 transition whitespace-nowrap ${tab === t ? 'border-primary text-text-primary' : 'border-transparent text-text-secondary hover:text-text-primary'}`}>
            {t.replace('-', ' ')}
          </button>
        ))}
      </div>
      {tab === 'loyalty'    && <LoyaltyTab />}
      {tab === 'zones'      && <ZonesTab />}
      {tab === 'surge'      && <SurgeTab />}
      {tab === 'webhooks'   && <WebhooksTab />}
      {tab === 'templates'  && <TemplatesTab />}
      {tab === 'app-version' && <AppVersionTab />}
      {tab === 'changelog'  && <ChangelogTab />}
      {tab === 'audit'      && <AuditTab />}
      {tab === 'blacklist'  && <BlacklistTab />}
    </div>
  );
}

// ── Loyalty ─────────────────────────────────────────────────────────
function LoyaltyTab() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['loyalty'], queryFn: growthApi.getLoyalty });
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [per100, setPer100]   = useState<number | null>(null);
  const [redeem, setRedeem]   = useState<number | null>(null);
  const [confirm, setConfirm] = useState(false);

  const m = useMutation({
    mutationFn: () => growthApi.setLoyalty({
      is_enabled: enabled ?? q.data!.is_enabled,
      points_per_100_inr: per100 ?? q.data!.points_per_100_inr,
      points_per_redeem_inr: redeem ?? q.data!.points_per_redeem_inr,
    }),
    onSuccess: () => { showToast({ kind: 'success', message: 'Loyalty saved.' }); qc.invalidateQueries({ queryKey: ['loyalty'] }); setConfirm(false); },
  });

  if (q.isLoading || !q.data) return <Skeleton className="h-32" />;
  const v = { enabled: enabled ?? q.data.is_enabled, per100: per100 ?? q.data.points_per_100_inr, redeem: redeem ?? q.data.points_per_redeem_inr };

  return (
    <Card className="space-y-4">
      <h2 className="text-sm font-semibold">Loyalty</h2>
      <label className="flex items-center justify-between">
        <span className="text-sm">Enabled</span>
        <input type="checkbox" checked={v.enabled} onChange={(e) => setEnabled(e.target.checked)} />
      </label>
      <label className="block text-sm">Points per ₹100 spent
        <input className="input mt-1" type="number" value={v.per100} onChange={(e) => setPer100(Number(e.target.value))} />
      </label>
      <label className="block text-sm">Points per ₹1 discount
        <input className="input mt-1" type="number" value={v.redeem} onChange={(e) => setRedeem(Number(e.target.value))} />
      </label>
      <div className="flex justify-end"><button className="btn-primary" onClick={() => setConfirm(true)}>Save</button></div>
      <ConfirmModal open={confirm} onClose={() => setConfirm(false)} onConfirm={() => m.mutateAsync()}
        title="Save loyalty config?" impact="Affects all future point accruals + redemptions." confirmLabel="Save" />
    </Card>
  );
}

// ── Zones ────────────────────────────────────────────────────────────
function ZonesTab() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['zones'], queryFn: zonesApi.list });
  const [editing, setEditing] = useState<Zone | null>(null);
  const [creating, setCreating] = useState(false);
  const tog = useMutation({
    mutationFn: ({ id, active }: { id: string; active: boolean }) => zonesApi.toggle(id, active),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['zones'] }),
  });

  return (
    <Card>
      <div className="flex justify-between mb-3">
        <h2 className="text-sm font-semibold">Zones (circle radius)</h2>
        <button className="btn-primary !py-1 !px-3" onClick={() => setCreating(true)}>+ New zone</button>
      </div>
      {q.isLoading ? <Skeleton className="h-32" /> :
        (q.data?.length ?? 0) === 0 ? <EmptyState title="No zones" /> :
          <div className="divide-y divide-border">
            {q.data?.map((z) => (
              <div key={z.id} className="py-3 flex items-center gap-3">
                <div className="flex-1 min-w-0">
                  <div className="font-semibold">{z.name} <span className="text-text-secondary text-xs">({z.city})</span></div>
                  <div className="text-[11px] text-text-muted font-mono">{z.lat.toFixed(4)}, {z.lon.toFixed(4)} · {z.radius_km}km</div>
                </div>
                <StatusPill tone={z.is_active ? 'success' : 'neutral'}>{z.is_active ? 'active' : 'off'}</StatusPill>
                <button className="btn-ghost !py-1 !px-2 text-xs" onClick={() => setEditing(z)}>Edit</button>
                <button className="btn-ghost !py-1 !px-2 text-xs" onClick={() => tog.mutate({ id: z.id, active: !z.is_active })}>{z.is_active ? 'Disable' : 'Enable'}</button>
              </div>
            ))}
          </div>
      }
      {(creating || editing) && <ZoneEditor z={editing} onClose={() => { setCreating(false); setEditing(null); }} />}
    </Card>
  );
}

function ZoneEditor({ z, onClose }: { z: Zone | null; onClose: () => void }) {
  const qc = useQueryClient();
  const [name, setName] = useState(z?.name ?? '');
  const [city, setCity] = useState(z?.city ?? '');
  const [lat, setLat]   = useState(z?.lat.toString() ?? '');
  const [lon, setLon]   = useState(z?.lon.toString() ?? '');
  const [rad, setRad]   = useState(z?.radius_km.toString() ?? '5');
  const m = useMutation({
    mutationFn: () => {
      const body = { name, city, lat: Number(lat), lon: Number(lon), radius_km: Number(rad) };
      return z ? zonesApi.update(z.id, body) : zonesApi.create(body);
    },
    onSuccess: () => { showToast({ kind: 'success', message: 'Saved.' }); qc.invalidateQueries({ queryKey: ['zones'] }); onClose(); },
  });
  return (
    <Modal open onClose={onClose} title={z ? 'Edit zone' : 'New zone'}>
      <div className="space-y-3">
        <input className="input" placeholder="Name" value={name} onChange={(e) => setName(e.target.value)} />
        <input className="input" placeholder="City" value={city} onChange={(e) => setCity(e.target.value)} />
        <div className="grid grid-cols-2 gap-2">
          <input className="input" placeholder="Lat" value={lat} onChange={(e) => setLat(e.target.value)} />
          <input className="input" placeholder="Lon" value={lon} onChange={(e) => setLon(e.target.value)} />
        </div>
        <input className="input" placeholder="Radius km" value={rad} onChange={(e) => setRad(e.target.value)} />
        <div className="flex justify-end gap-2 pt-3 border-t border-border">
          <button className="btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn-primary" onClick={() => m.mutateAsync()}>Save</button>
        </div>
      </div>
    </Modal>
  );
}

// ── Surge ────────────────────────────────────────────────────────────
function SurgeTab() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['surge'], queryFn: zonesApi.surgeList });
  const z = useQuery({ queryKey: ['zones'], queryFn: zonesApi.list });
  const [zoneID, setZoneID] = useState('');
  const [mul, setMul]       = useState('1.5');
  const [reason, setReason] = useState('');
  const [del, setDel]       = useState<string | null>(null);

  const create = useMutation({
    mutationFn: () => zonesApi.surgeCreate({ zone_id: zoneID, multiplier: Number(mul), reason: reason || undefined }),
    onSuccess: () => { showToast({ kind: 'success', message: 'Surge rule created.' }); qc.invalidateQueries({ queryKey: ['surge'] }); setReason(''); },
  });
  const remove = useMutation({
    mutationFn: (id: string) => zonesApi.surgeDelete(id),
    onSuccess: () => { showToast({ kind: 'success', message: 'Removed.' }); qc.invalidateQueries({ queryKey: ['surge'] }); setDel(null); },
  });

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
      <Card>
        <h3 className="text-sm font-semibold mb-3">New rule</h3>
        <div className="space-y-3">
          <select className="input" value={zoneID} onChange={(e) => setZoneID(e.target.value)}>
            <option value="">— pick zone —</option>
            {z.data?.map((zn) => <option key={zn.id} value={zn.id}>{zn.name} ({zn.city})</option>)}
          </select>
          <input className="input" placeholder="Multiplier (e.g. 1.5)" value={mul} onChange={(e) => setMul(e.target.value)} />
          <input className="input" placeholder="Reason (optional)" value={reason} onChange={(e) => setReason(e.target.value)} />
          <button className="btn-primary w-full" disabled={!zoneID || !mul} onClick={() => create.mutateAsync()}>Add</button>
        </div>
      </Card>
      <Card>
        <h3 className="text-sm font-semibold mb-3">Active rules</h3>
        {q.isLoading ? <Skeleton className="h-32" /> :
          (q.data?.length ?? 0) === 0 ? <EmptyState title="No active surge rules" /> :
            <div className="divide-y divide-border">
              {q.data?.map((s) => (
                <div key={s.id} className="py-2 flex items-center gap-3">
                  <div className="flex-1 text-sm">
                    <div className="font-mono">{s.multiplier.toFixed(2)}×</div>
                    <div className="text-[11px] text-text-muted">{s.zone_id.slice(0, 8)} · {s.reason ?? '—'}</div>
                  </div>
                  <button className="btn-ghost text-danger !py-1 !px-2 text-xs" onClick={() => setDel(s.id)}>Remove</button>
                </div>
              ))}
            </div>
        }
      </Card>
      <ConfirmModal open={!!del} onClose={() => setDel(null)} onConfirm={() => remove.mutateAsync(del!)} title="Remove surge rule?" impact="Pricing reverts to normal immediately." destructive confirmLabel="Remove" />
    </div>
  );
}

// ── Webhooks ─────────────────────────────────────────────────────────
function WebhooksTab() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['webhooks'], queryFn: platformApi.listWebhooks });
  const [url, setUrl] = useState('');
  const [events, setEvents] = useState('order.completed,refund.approved');
  const create = useMutation({
    mutationFn: () => platformApi.createWebhook({ url, events: events.split(',').map((s) => s.trim()).filter(Boolean) }),
    onSuccess: () => { showToast({ kind: 'success', message: 'Webhook added.' }); qc.invalidateQueries({ queryKey: ['webhooks'] }); setUrl(''); },
  });
  const del = useMutation({
    mutationFn: (id: string) => platformApi.deleteWebhook(id),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['webhooks'] }); showToast({ kind: 'success', message: 'Removed.' }); },
  });
  return (
    <Card>
      <h2 className="text-sm font-semibold mb-3">Webhooks</h2>
      <div className="grid grid-cols-2 gap-2 mb-4">
        <input className="input" placeholder="https://your-server/hook" value={url} onChange={(e) => setUrl(e.target.value)} />
        <input className="input" placeholder="events,comma,separated" value={events} onChange={(e) => setEvents(e.target.value)} />
      </div>
      <button className="btn-primary mb-4" disabled={!url} onClick={() => create.mutateAsync()}>Add</button>
      {q.isLoading ? <Skeleton className="h-32" /> :
        (q.data?.length ?? 0) === 0 ? <EmptyState title="No webhooks" /> :
          <div className="divide-y divide-border">
            {q.data?.map((w) => (
              <div key={w.id} className="py-2 flex items-center gap-3">
                <div className="flex-1 min-w-0">
                  <div className="font-mono text-xs truncate">{w.url}</div>
                  <div className="text-[11px] text-text-muted">{w.events.join(', ')}</div>
                </div>
                <StatusPill tone={w.is_active ? 'success' : 'neutral'}>{w.is_active ? 'active' : 'off'}</StatusPill>
                <button className="btn-ghost text-danger !py-1 !px-2 text-xs" onClick={() => del.mutate(w.id)}>Delete</button>
              </div>
            ))}
          </div>
      }
    </Card>
  );
}

// ── Templates ────────────────────────────────────────────────────────
function TemplatesTab() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['templates'], queryFn: platformApi.listTemplates });
  const [cat, setCat] = useState('refund');
  const [name, setName] = useState('');
  const [body, setBody] = useState('');
  const create = useMutation({
    mutationFn: () => platformApi.createTemplate({ category: cat, name, body }),
    onSuccess: () => { showToast({ kind: 'success', message: 'Template added.' }); qc.invalidateQueries({ queryKey: ['templates'] }); setName(''); setBody(''); },
  });
  const del = useMutation({
    mutationFn: (id: string) => platformApi.deleteTemplate(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['templates'] }),
  });
  return (
    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
      <Card>
        <h3 className="text-sm font-semibold mb-3">New template</h3>
        <div className="space-y-3">
          <select className="input" value={cat} onChange={(e) => setCat(e.target.value)}>
            <option>refund</option><option>complaint</option><option>worker_issue</option><option>general</option>
          </select>
          <input className="input" placeholder="Name" value={name} onChange={(e) => setName(e.target.value)} />
          <textarea className="input min-h-[120px]" placeholder="Body" value={body} onChange={(e) => setBody(e.target.value)} />
          <button className="btn-primary w-full" disabled={!name || !body} onClick={() => create.mutateAsync()}>Add</button>
        </div>
      </Card>
      <Card>
        <h3 className="text-sm font-semibold mb-3">Library</h3>
        {q.isLoading ? <Skeleton className="h-32" /> :
          (q.data?.length ?? 0) === 0 ? <EmptyState title="No templates" /> :
            <div className="divide-y divide-border max-h-[420px] overflow-y-auto">
              {q.data?.map((t) => (
                <div key={t.id} className="py-2">
                  <div className="flex items-center gap-2">
                    <StatusPill tone="info">{t.category}</StatusPill>
                    <div className="font-semibold flex-1">{t.name}</div>
                    <button className="btn-ghost text-danger !py-1 !px-2 text-xs" onClick={() => del.mutate(t.id)}>×</button>
                  </div>
                  <div className="text-xs text-text-secondary mt-1 whitespace-pre-wrap">{t.body}</div>
                </div>
              ))}
            </div>
        }
      </Card>
    </div>
  );
}

// ── App version ──────────────────────────────────────────────────────
function AppVersionTab() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['app-versions'], queryFn: platformApi.listAppVersions });
  const [platform, setPlatform] = useState<'ios' | 'android' | 'any'>('any');
  const [min, setMin] = useState('');
  const [force, setForce] = useState(false);
  const [msg, setMsg] = useState('');
  const create = useMutation({
    mutationFn: () => platformApi.setAppVersion({ platform, min_version: min, force_update: force, force_message: msg || undefined }),
    onSuccess: () => { showToast({ kind: 'success', message: 'Version policy saved.' }); qc.invalidateQueries({ queryKey: ['app-versions'] }); setMin(''); setMsg(''); setForce(false); },
  });
  return (
    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
      <Card>
        <h3 className="text-sm font-semibold mb-3">Set min version</h3>
        <div className="space-y-3">
          <select className="input" value={platform} onChange={(e) => setPlatform(e.target.value as typeof platform)}>
            <option value="any">Any</option><option value="ios">iOS</option><option value="android">Android</option>
          </select>
          <input className="input" placeholder="Min version (e.g. 1.4.2)" value={min} onChange={(e) => setMin(e.target.value)} />
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={force} onChange={(e) => setForce(e.target.checked)} /> Force update</label>
          {force && <textarea className="input min-h-[60px]" placeholder="Force update message" value={msg} onChange={(e) => setMsg(e.target.value)} />}
          <button className="btn-primary w-full" disabled={!min} onClick={() => create.mutateAsync()}>Save policy</button>
        </div>
      </Card>
      <Card>
        <h3 className="text-sm font-semibold mb-3">History</h3>
        {q.isLoading ? <Skeleton className="h-32" /> :
          (q.data?.length ?? 0) === 0 ? <EmptyState title="No policies set" /> :
            <div className="divide-y divide-border max-h-[420px] overflow-y-auto">
              {q.data?.map((v) => (
                <div key={v.id} className="py-2 text-sm">
                  <div><StatusPill tone="info">{v.platform}</StatusPill> ≥ <code className="font-mono">{v.min_version}</code> {v.force_update && <StatusPill tone="warning">force</StatusPill>}</div>
                  <div className="text-[11px] text-text-muted">{new Date(v.created_at).toLocaleString()}</div>
                </div>
              ))}
            </div>
        }
      </Card>
    </div>
  );
}

// ── Changelog ────────────────────────────────────────────────────────
function ChangelogTab() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['changelog'], queryFn: platformApi.listChangelog });
  const [v, setV] = useState('');
  const [body, setBody] = useState('');
  const [pub, setPub] = useState(false);
  const create = useMutation({
    mutationFn: () => platformApi.createChangelog({ version: v, body, is_published: pub }),
    onSuccess: () => { showToast({ kind: 'success', message: 'Saved.' }); qc.invalidateQueries({ queryKey: ['changelog'] }); setV(''); setBody(''); setPub(false); },
  });
  return (
    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
      <Card>
        <h3 className="text-sm font-semibold mb-3">New entry</h3>
        <div className="space-y-3">
          <input className="input" placeholder="Version (e.g. 1.5.0)" value={v} onChange={(e) => setV(e.target.value)} />
          <textarea className="input min-h-[120px]" placeholder="Body (markdown ok)" value={body} onChange={(e) => setBody(e.target.value)} />
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={pub} onChange={(e) => setPub(e.target.checked)} /> Publish immediately</label>
          <button className="btn-primary w-full" disabled={!v || !body} onClick={() => create.mutateAsync()}>Save</button>
        </div>
      </Card>
      <Card>
        <h3 className="text-sm font-semibold mb-3">Published</h3>
        {q.isLoading ? <Skeleton className="h-32" /> :
          (q.data?.length ?? 0) === 0 ? <EmptyState title="No changelog yet" /> :
            <div className="divide-y divide-border max-h-[420px] overflow-y-auto">
              {q.data?.map((e) => (
                <div key={e.id} className="py-3">
                  <div className="flex items-center gap-2">
                    <code className="font-mono text-sm">{e.version}</code>
                    <StatusPill tone={e.is_published ? 'success' : 'neutral'}>{e.is_published ? 'published' : 'draft'}</StatusPill>
                  </div>
                  <pre className="whitespace-pre-wrap text-xs text-text-secondary mt-1">{e.body}</pre>
                </div>
              ))}
            </div>
        }
      </Card>
    </div>
  );
}

// ── Audit log viewer ─────────────────────────────────────────────────
function AuditTab() {
  const [module, setModule] = useState('');
  const [action, setAction] = useState('');
  const q = useQuery({ queryKey: ['audit', module, action], queryFn: () => platformApi.listAudit({ module, action, limit: 200 }) });
  return (
    <Card>
      <div className="flex gap-2 mb-3">
        <input className="input" placeholder="Filter module" value={module} onChange={(e) => setModule(e.target.value)} />
        <input className="input" placeholder="Filter action" value={action} onChange={(e) => setAction(e.target.value)} />
      </div>
      {q.isLoading ? <Skeleton className="h-32" /> :
        (q.data?.length ?? 0) === 0 ? <EmptyState title="No matching rows" /> :
          <div className="max-h-[600px] overflow-y-auto text-xs font-mono">
            {q.data?.map((a) => (
              <div key={a.id} className="border-t border-border py-2">
                <div className="flex items-center gap-2">
                  <StatusPill tone="info">{a.module}</StatusPill>
                  <span className="text-text-primary">{a.action}</span>
                  <span className="text-text-muted text-[10px]">{a.target_type}/{a.target_id?.slice(0, 8)}</span>
                  <span className="ml-auto text-text-secondary text-[10px]">{a.admin_email} · {new Date(a.created_at).toLocaleString()}</span>
                </div>
              </div>
            ))}
          </div>
      }
    </Card>
  );
}

// ── Blacklist ────────────────────────────────────────────────────────
function BlacklistTab() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['blacklist'], queryFn: tsApi.listBlacklist });
  const [kind, setKind] = useState<'phone' | 'email' | 'device_id' | 'ip'>('phone');
  const [val, setVal] = useState('');
  const [reason, setReason] = useState('');
  const add = useMutation({
    mutationFn: () => tsApi.addBlacklist({ kind, value: val, reason }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['blacklist'] }); setVal(''); setReason(''); showToast({ kind: 'success', message: 'Added.' }); },
  });
  const del = useMutation({
    mutationFn: (id: string) => tsApi.removeBlacklist(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['blacklist'] }),
  });
  return (
    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
      <Card>
        <h3 className="text-sm font-semibold mb-3">Add to blacklist</h3>
        <div className="space-y-3">
          <select className="input" value={kind} onChange={(e) => setKind(e.target.value as typeof kind)}>
            <option value="phone">phone</option><option value="email">email</option><option value="device_id">device_id</option><option value="ip">ip</option>
          </select>
          <input className="input" placeholder="Value" value={val} onChange={(e) => setVal(e.target.value)} />
          <input className="input" placeholder="Reason" value={reason} onChange={(e) => setReason(e.target.value)} />
          <button className="btn-primary w-full" disabled={!val || !reason} onClick={() => add.mutateAsync()}>Add</button>
        </div>
      </Card>
      <Card>
        <h3 className="text-sm font-semibold mb-3">Blacklist</h3>
        {q.isLoading ? <Skeleton className="h-32" /> :
          (q.data?.length ?? 0) === 0 ? <EmptyState title="Empty" /> :
            <div className="divide-y divide-border max-h-[420px] overflow-y-auto">
              {q.data?.map((b) => (
                <div key={b.id} className="py-2 flex items-center gap-3">
                  <StatusPill tone="warning">{b.kind}</StatusPill>
                  <div className="flex-1 min-w-0 text-xs">
                    <div className="font-mono truncate">{b.value}</div>
                    <div className="text-[11px] text-text-muted">{b.reason}</div>
                  </div>
                  <button className="btn-ghost text-danger !py-1 !px-2 text-xs" onClick={() => del.mutate(b.id)}>Remove</button>
                </div>
              ))}
            </div>
        }
      </Card>
    </div>
  );
}
