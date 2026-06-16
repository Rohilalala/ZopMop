import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { growthApi, zonesApi, platformApi, tsApi, type Zone, type Webhook, type WebhookDelivery } from '@/api/all';
import { Card, EmptyState, Skeleton, StatusPill } from '@/components/ui';
import { ConfirmModal, Modal } from '@/components/ui/Modal';
import { Drawer } from '@/components/ui/Drawer';
import { showToast } from '@/components/ui/Toast';
import { Can } from '@/auth/Can';
import { usePermission } from '@/auth/usePermission';

// SettingsPage: hub for the smaller config-y modules — loyalty config, zones,
// surge, app version, changelog, response templates, audit log viewer.
// Each section is collapsible-ish (accordion via simple heading).

const TABS = [
  'loyalty', 'zones', 'surge', 'webhooks', 'templates',
  'app-version', 'changelog', 'audit', 'blacklist',
] as const;
type Tab = typeof TABS[number];

// Superadmin-only tabs are hidden from lower roles since their tab pages have
// no read-only utility — only write controls. Audit + read-only tabs remain
// visible to all. Per-button gating still applies inside each tab below.

export function SettingsPage() {
  const canWebhooks   = usePermission('webhooks.create');
  const canAppVersion = usePermission('app_version.update');
  const canChangelog  = usePermission('changelog.publish');
  const canLoyalty    = usePermission('loyalty.update');

  const visibleTabs = TABS.filter((t) => {
    if (t === 'webhooks')    return canWebhooks;
    if (t === 'app-version') return canAppVersion;
    if (t === 'changelog')   return canChangelog;
    if (t === 'loyalty')     return canLoyalty;
    return true;
  });

  const [tab, setTab] = useState<Tab>(visibleTabs[0] ?? 'zones');
  // If the chosen tab is no longer visible (rare; role downgrade mid-session),
  // fall back to the first visible.
  const activeTab: Tab = visibleTabs.includes(tab) ? tab : (visibleTabs[0] ?? 'zones');
  return (
    <div className="p-6 space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Settings</h1>
        <p className="text-sm text-text-secondary mt-1">Loyalty, zones, surge, webhooks, templates, app version, changelog, audit log, blacklist.</p>
      </div>
      <div className="flex gap-1 border-b border-border overflow-x-auto">
        {visibleTabs.map((t) => (
          <button key={t} onClick={() => setTab(t)} className={`px-4 py-2 text-sm capitalize border-b-2 transition whitespace-nowrap ${activeTab === t ? 'border-primary text-text-primary' : 'border-transparent text-text-secondary hover:text-text-primary'}`}>
            {t.replace('-', ' ')}
          </button>
        ))}
      </div>
      {activeTab === 'loyalty'    && <LoyaltyTab />}
      {activeTab === 'zones'      && <ZonesTab />}
      {activeTab === 'surge'      && <SurgeTab />}
      {activeTab === 'webhooks'   && <WebhooksTab />}
      {activeTab === 'templates'  && <TemplatesTab />}
      {activeTab === 'app-version' && <AppVersionTab />}
      {activeTab === 'changelog'  && <ChangelogTab />}
      {activeTab === 'audit'      && <AuditTab />}
      {activeTab === 'blacklist'  && <BlacklistTab />}
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
      // The form has no editor for bonus_rules; the backend defaults an absent
      // value to [], so echo the existing rules back to avoid wiping them.
      bonus_rules: q.data!.bonus_rules,
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
      <div className="flex justify-end">
        <LoyaltySaveBtn onClick={() => setConfirm(true)} />
      </div>
      <ConfirmModal open={confirm} onClose={() => setConfirm(false)} onConfirm={() => m.mutateAsync()}
        title="Save loyalty config?" impact="Affects all future point accruals + redemptions." confirmLabel="Save" />
    </Card>
  );
}

function LoyaltySaveBtn({ onClick }: { onClick: () => void }) {
  const can = usePermission('loyalty.update');
  return (
    <button
      className="btn-primary"
      disabled={!can}
      title={!can ? 'Insufficient permissions' : undefined}
      onClick={() => {
        if (!can) {
          showToast({ kind: 'error', message: 'Insufficient permissions' });
          return;
        }
        onClick();
      }}
    >Save</button>
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
  const canToggle = usePermission('zones.toggle');

  return (
    <Card>
      <div className="flex justify-between mb-3">
        <h2 className="text-sm font-semibold">Zones (circle radius)</h2>
        <Can perm="zones.create">
          <button className="btn-primary !py-1 !px-3" onClick={() => setCreating(true)}>+ New zone</button>
        </Can>
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
                <button
                  className="btn-ghost !py-1 !px-2 text-xs"
                  disabled={!canToggle}
                  title={!canToggle ? 'Insufficient permissions' : undefined}
                  onClick={() => {
                    if (!canToggle) {
                      showToast({ kind: 'error', message: 'Insufficient permissions' });
                      return;
                    }
                    tog.mutate({ id: z.id, active: !z.is_active });
                  }}
                >{z.is_active ? 'Disable' : 'Enable'}</button>
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
  const canCreate = usePermission('zones.create');
  const canUpdate = usePermission('zones.update');
  const canSave = z ? canUpdate : canCreate;
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
          <button
            className="btn-primary"
            disabled={!canSave}
            title={!canSave ? 'Insufficient permissions' : undefined}
            onClick={() => {
              if (!canSave) {
                showToast({ kind: 'error', message: 'Insufficient permissions' });
                return;
              }
              m.mutateAsync();
            }}
          >Save</button>
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
  const canCreate = usePermission('surge.create');
  const canDelete = usePermission('surge.delete');

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
          <button
            className="btn-primary w-full"
            disabled={!zoneID || !mul || !canCreate}
            title={!canCreate ? 'Insufficient permissions' : undefined}
            onClick={() => {
              if (!canCreate) {
                showToast({ kind: 'error', message: 'Insufficient permissions' });
                return;
              }
              create.mutateAsync();
            }}
          >Add</button>
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
                  <button
                    className="btn-ghost text-danger !py-1 !px-2 text-xs"
                    disabled={!canDelete}
                    title={!canDelete ? 'Insufficient permissions' : undefined}
                    onClick={() => {
                      if (!canDelete) {
                        showToast({ kind: 'error', message: 'Insufficient permissions' });
                        return;
                      }
                      setDel(s.id);
                    }}
                  >Remove</button>
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
  const [testing, setTesting] = useState<Webhook | null>(null);
  const [viewing, setViewing] = useState<Webhook | null>(null);
  const create = useMutation({
    mutationFn: () => platformApi.createWebhook({ url, events: events.split(',').map((s) => s.trim()).filter(Boolean) }),
    onSuccess: () => { showToast({ kind: 'success', message: 'Webhook added.' }); qc.invalidateQueries({ queryKey: ['webhooks'] }); setUrl(''); },
  });
  const del = useMutation({
    mutationFn: (id: string) => platformApi.deleteWebhook(id),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['webhooks'] }); showToast({ kind: 'success', message: 'Removed.' }); },
  });
  const canCreate = usePermission('webhooks.create');
  const canDelete = usePermission('webhooks.delete');
  return (
    <Card>
      <h2 className="text-sm font-semibold mb-3">Webhooks</h2>
      <div className="grid grid-cols-2 gap-2 mb-4">
        <input className="input" placeholder="https://your-server/hook" value={url} onChange={(e) => setUrl(e.target.value)} />
        <input className="input" placeholder="events,comma,separated" value={events} onChange={(e) => setEvents(e.target.value)} />
      </div>
      <button
        className="btn-primary mb-4"
        disabled={!url || !canCreate}
        title={!canCreate ? 'Insufficient permissions' : undefined}
        onClick={() => {
          if (!canCreate) {
            showToast({ kind: 'error', message: 'Insufficient permissions' });
            return;
          }
          create.mutateAsync();
        }}
      >Add</button>
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
                <Can perm="webhooks.create">
                  <button
                    className="btn-ghost !py-1 !px-2 text-xs"
                    onClick={() => setTesting(w)}
                  >Test</button>
                </Can>
                <button
                  className="btn-ghost !py-1 !px-2 text-xs"
                  onClick={() => setViewing(w)}
                >Deliveries</button>
                <button
                  className="btn-ghost text-danger !py-1 !px-2 text-xs"
                  disabled={!canDelete}
                  title={!canDelete ? 'Insufficient permissions' : undefined}
                  onClick={() => {
                    if (!canDelete) {
                      showToast({ kind: 'error', message: 'Insufficient permissions' });
                      return;
                    }
                    del.mutate(w.id);
                  }}
                >Delete</button>
              </div>
            ))}
          </div>
      }
      {testing && <WebhookTestModal webhook={testing} onClose={() => setTesting(null)} />}
      {viewing && <WebhookDeliveriesDrawer webhook={viewing} onClose={() => setViewing(null)} />}
    </Card>
  );
}

// Default sample payload — built fresh each render so the unix timestamp is current.
function defaultSample(): string {
  return JSON.stringify({ message: 'hello from zopmop', ts: Math.floor(Date.now() / 1000) }, null, 2);
}

// WebhookTestModal: pick an event name + JSON sample, fire a test ping, render
// the resulting Delivery row inline. JSON-validates before submit; if parse
// fails, surface "Invalid JSON" inline and abort the call.
function WebhookTestModal({ webhook, onClose }: { webhook: Webhook; onClose: () => void }) {
  const [event, setEvent] = useState('test.ping');
  const [sample, setSample] = useState(defaultSample());
  const [jsonErr, setJsonErr] = useState<string | null>(null);
  const [result, setResult] = useState<WebhookDelivery | null>(null);

  const send = useMutation({
    mutationFn: (body: { event: string; sample: unknown }) => platformApi.testWebhook(webhook.id, body),
    onSuccess: (dlv) => {
      setResult(dlv);
      showToast({
        kind: dlv.succeeded ? 'success' : 'error',
        message: dlv.succeeded ? `Test sent — ${dlv.status_code ?? 'OK'}` : `Test failed — ${dlv.status_code ?? 'no response'}`,
      });
    },
    onError: () => showToast({ kind: 'error', message: 'Test request failed.' }),
  });

  function onSend() {
    setJsonErr(null);
    let parsed: unknown;
    try {
      parsed = JSON.parse(sample);
    } catch {
      setJsonErr('Invalid JSON');
      return;
    }
    send.mutate({ event, sample: parsed });
  }

  return (
    <Modal open onClose={onClose} title="Test webhook" width="max-w-xl">
      <div className="space-y-3">
        <div className="text-xs text-text-muted font-mono truncate">{webhook.url}</div>
        <label className="block text-xs uppercase tracking-wider text-text-muted">Event
          <input className="input mt-1" value={event} onChange={(e) => setEvent(e.target.value)} />
        </label>
        <label className="block text-xs uppercase tracking-wider text-text-muted">Sample payload (JSON)
          <textarea
            className="input mt-1 min-h-[140px] font-mono text-xs"
            value={sample}
            onChange={(e) => { setSample(e.target.value); if (jsonErr) setJsonErr(null); }}
            spellCheck={false}
          />
        </label>
        {jsonErr && <div className="text-xs text-danger">{jsonErr}</div>}
        <div className="flex justify-end gap-2 pt-3 border-t border-border">
          <button className="btn-ghost" onClick={onClose} disabled={send.isPending}>Close</button>
          <button className="btn-primary" disabled={send.isPending || !event} onClick={onSend}>
            {send.isPending ? 'Sending…' : 'Send'}
          </button>
        </div>
        {result && <DeliveryResultCard d={result} />}
      </div>
    </Modal>
  );
}

// Inline summary of a Delivery returned by /test.
function DeliveryResultCard({ d }: { d: WebhookDelivery }) {
  const code = d.status_code ?? 0;
  const tone: 'success' | 'danger' = d.succeeded ? 'success' : 'danger';
  return (
    <div className="mt-3 border border-border rounded-md p-3 space-y-2 bg-surface-elevated">
      <div className="flex items-center gap-2">
        <StatusPill tone={tone}>{d.succeeded ? 'succeeded' : 'failed'}</StatusPill>
        <span className="font-mono text-xs">{code === 0 ? 'ERROR' : code}</span>
        <span className="text-[11px] text-text-muted ml-auto">{d.duration_ms ?? '—'} ms</span>
      </div>
      <pre className="text-[11px] text-text-secondary whitespace-pre-wrap break-words max-h-40 overflow-y-auto">
        {(d.response_body ?? '').slice(0, 2000) || '(empty body)'}
      </pre>
    </div>
  );
}

// WebhookDeliveriesDrawer: right-side drawer listing recent deliveries. Polls
// every 10s while mounted. Per-row Retry button if !succeeded.
function WebhookDeliveriesDrawer({ webhook, onClose }: { webhook: Webhook; onClose: () => void }) {
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ['webhook-deliveries', webhook.id],
    queryFn: () => platformApi.listDeliveries(webhook.id),
    refetchInterval: 10_000,
  });
  const [confirmRetry, setConfirmRetry] = useState<WebhookDelivery | null>(null);
  const canRetry = usePermission('webhooks.create');

  const retry = useMutation({
    mutationFn: (id: number) => platformApi.retryDelivery(id),
    onSuccess: (res) => {
      showToast({ kind: 'success', message: `Replayed — new delivery #${res.new_delivery_id}` });
      setConfirmRetry(null);
      qc.invalidateQueries({ queryKey: ['webhook-deliveries', webhook.id] });
    },
    onError: () => showToast({ kind: 'error', message: 'Retry failed.' }),
  });

  return (
    <Drawer open onClose={onClose} width="max-w-3xl">
      <div className="p-6 space-y-4">
        <div>
          <h2 className="text-lg font-semibold">Webhook deliveries</h2>
          <div className="text-xs text-text-muted font-mono truncate mt-1">{webhook.url}</div>
          <div className="text-[11px] text-text-muted mt-1">Polling every 10s.</div>
        </div>
        {q.isLoading ? <Skeleton className="h-40" /> :
          (q.data?.length ?? 0) === 0 ? <EmptyState title="No deliveries yet" body="Fire a Test ping or wait for an event." /> :
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead className="text-text-muted uppercase tracking-wider text-[10px] border-b border-border">
                  <tr>
                    <th className="text-left py-2 pr-3">Time</th>
                    <th className="text-left py-2 pr-3">Event</th>
                    <th className="text-left py-2 pr-3">Status</th>
                    <th className="text-left py-2 pr-3">Duration</th>
                    <th className="text-left py-2 pr-3">Result</th>
                    <th className="text-left py-2 pr-3">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {q.data?.map((d) => {
                    const code = d.status_code ?? 0;
                    const tone: 'success' | 'danger' = code >= 200 && code < 300 ? 'success' : 'danger';
                    const label = code === 0 ? 'ERROR' : String(code);
                    return (
                      <tr key={d.id} className="align-top">
                        <td className="py-2 pr-3 whitespace-nowrap text-text-secondary">{new Date(d.created_at).toLocaleString()}</td>
                        <td className="py-2 pr-3 font-mono">{d.event}</td>
                        <td className="py-2 pr-3"><StatusPill tone={tone}>{label}</StatusPill></td>
                        <td className="py-2 pr-3 text-text-secondary">{d.duration_ms ?? '—'} ms</td>
                        <td className="py-2 pr-3 font-mono text-text-secondary max-w-[260px] truncate" title={d.response_body ?? ''}>
                          {(d.response_body ?? '').slice(0, 80) || '—'}
                        </td>
                        <td className="py-2 pr-3 whitespace-nowrap">
                          {d.retried_at && (
                            <span className="text-[10px] text-text-muted mr-2">replayed {new Date(d.retried_at).toLocaleTimeString()}</span>
                          )}
                          {!d.succeeded && (
                            <button
                              className="btn-ghost !py-0.5 !px-2 text-[11px]"
                              disabled={!canRetry || retry.isPending}
                              title={!canRetry ? 'Insufficient permissions' : undefined}
                              onClick={() => {
                                if (!canRetry) {
                                  showToast({ kind: 'error', message: 'Insufficient permissions' });
                                  return;
                                }
                                setConfirmRetry(d);
                              }}
                            >Retry</button>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
        }
      </div>
      <ConfirmModal
        open={!!confirmRetry}
        onClose={() => setConfirmRetry(null)}
        onConfirm={async () => { if (confirmRetry) await retry.mutateAsync(confirmRetry.id); }}
        title="Retry delivery?"
        impact={<>Re-sends the same payload to <span className="font-mono">{webhook.url}</span>. Creates a new delivery row.</>}
        confirmLabel="Retry"
      />
    </Drawer>
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
  const canCreate = usePermission('templates.create');
  const canDelete = usePermission('templates.delete');
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
          <button
            className="btn-primary w-full"
            disabled={!name || !body || !canCreate}
            title={!canCreate ? 'Insufficient permissions' : undefined}
            onClick={() => {
              if (!canCreate) {
                showToast({ kind: 'error', message: 'Insufficient permissions' });
                return;
              }
              create.mutateAsync();
            }}
          >Add</button>
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
                    <button
                      className="btn-ghost text-danger !py-1 !px-2 text-xs"
                      disabled={!canDelete}
                      title={!canDelete ? 'Insufficient permissions' : undefined}
                      onClick={() => {
                        if (!canDelete) {
                          showToast({ kind: 'error', message: 'Insufficient permissions' });
                          return;
                        }
                        del.mutate(t.id);
                      }}
                    >×</button>
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
  const [iosUrl, setIosUrl] = useState('');
  const [androidUrl, setAndroidUrl] = useState('');
  const create = useMutation({
    mutationFn: () => platformApi.setAppVersion({
      platform, min_version: min, force_update: force,
      force_message: msg || undefined,
      ios_store_url: iosUrl || undefined,
      android_store_url: androidUrl || undefined,
    }),
    onSuccess: () => { showToast({ kind: 'success', message: 'Version policy saved.' }); qc.invalidateQueries({ queryKey: ['app-versions'] }); setMin(''); setMsg(''); setForce(false); setIosUrl(''); setAndroidUrl(''); },
  });
  const canSave = usePermission('app_version.update');
  return (
    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
      <Card>
        <h3 className="text-sm font-semibold mb-3">Set min version</h3>
        <div className="space-y-3">
          <select className="input" value={platform} onChange={(e) => setPlatform(e.target.value as typeof platform)}>
            <option value="any">Any</option><option value="ios">iOS</option><option value="android">Android</option>
          </select>
          <input className="input" placeholder="Min version (e.g. 1.4.2)" value={min} onChange={(e) => setMin(e.target.value)} />
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={force} onChange={(e) => setForce(e.target.checked)} /> Required update (block older apps)</label>
          <p className="text-[11px] text-text-muted -mt-1">
            {force
              ? 'Required: users below this version are blocked until they update.'
              : 'Optional: users below this version see a dismissable prompt and can keep using the app.'}
          </p>
          <textarea className="input min-h-[60px]" placeholder={force ? 'Update message (shown on the block screen)' : 'Update message (shown on the prompt)'} value={msg} onChange={(e) => setMsg(e.target.value)} />
          {platform !== 'android' && (
            <input className="input" placeholder="iOS App Store URL" value={iosUrl} onChange={(e) => setIosUrl(e.target.value)} />
          )}
          {platform !== 'ios' && (
            <input className="input" placeholder="Android Play Store URL" value={androidUrl} onChange={(e) => setAndroidUrl(e.target.value)} />
          )}
          <button
            className="btn-primary w-full"
            disabled={!min || !canSave}
            title={!canSave ? 'Insufficient permissions' : undefined}
            onClick={() => {
              if (!canSave) {
                showToast({ kind: 'error', message: 'Insufficient permissions' });
                return;
              }
              create.mutateAsync();
            }}
          >Save policy</button>
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
  const canSave = usePermission('changelog.publish');
  return (
    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
      <Card>
        <h3 className="text-sm font-semibold mb-3">New entry</h3>
        <div className="space-y-3">
          <input className="input" placeholder="Version (e.g. 1.5.0)" value={v} onChange={(e) => setV(e.target.value)} />
          <textarea className="input min-h-[120px]" placeholder="Body (markdown ok)" value={body} onChange={(e) => setBody(e.target.value)} />
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={pub} onChange={(e) => setPub(e.target.checked)} /> Publish immediately</label>
          <button
            className="btn-primary w-full"
            disabled={!v || !body || !canSave}
            title={!canSave ? 'Insufficient permissions' : undefined}
            onClick={() => {
              if (!canSave) {
                showToast({ kind: 'error', message: 'Insufficient permissions' });
                return;
              }
              create.mutateAsync();
            }}
          >Save</button>
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
  const canAdd    = usePermission('blacklist.add');
  const canRemove = usePermission('blacklist.remove');
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
          <button
            className="btn-primary w-full"
            disabled={!val || !reason || !canAdd}
            title={!canAdd ? 'Insufficient permissions' : undefined}
            onClick={() => {
              if (!canAdd) {
                showToast({ kind: 'error', message: 'Insufficient permissions' });
                return;
              }
              add.mutateAsync();
            }}
          >Add</button>
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
                  <button
                    className="btn-ghost text-danger !py-1 !px-2 text-xs"
                    disabled={!canRemove}
                    title={!canRemove ? 'Insufficient permissions' : undefined}
                    onClick={() => {
                      if (!canRemove) {
                        showToast({ kind: 'error', message: 'Insufficient permissions' });
                        return;
                      }
                      del.mutate(b.id);
                    }}
                  >Remove</button>
                </div>
              ))}
            </div>
        }
      </Card>
    </div>
  );
}
