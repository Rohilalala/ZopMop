import { useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { format as formatDate, formatDistanceToNow } from 'date-fns';
import {
  AlertCircle, ChevronDown, Copy, FileText, RefreshCw, Search, ShieldAlert,
  X,
} from 'lucide-react';

import { listAudit, auditKeys, type AuditRow } from '@/api/audit';
import { Card, EmptyState, Skeleton, StatusPill } from '@/components/ui';
import { Modal } from '@/components/ui/Modal';
import { showToast } from '@/components/ui/Toast';
import { usePermission } from '@/auth/usePermission';

// Hard-coded module list — backend uses freeform strings in crm_audit_log.module
// so we enumerate the known set to drive the dropdown. New backend modules
// can be filtered via the free-text Action input until added here.
const MODULES = [
  'auth', 'banners', 'blacklist', 'changelog', 'disputes', 'experiments',
  'flags', 'fraud', 'growth', 'incidents', 'leaves', 'localities', 'orders',
  'payouts', 'platform', 'promos', 'refunds', 'surge', 'tickets', 'users',
  'workers', 'zone-approvals', 'zones',
];

const ENTITY_TYPES = [
  'worker', 'order', 'user', 'refund', 'zone_approval_request', 'leave',
  'promo', 'banner', 'experiment', 'payout', 'webhook', 'flag',
];

const LIMIT_OPTIONS = [25, 50, 100, 200, 500];

type Filters = {
  module: string;
  action: string;
  admin_email: string;
  entity_type: string;
  entity_id: string;
  from: string;
  to: string;
  limit: number;
};

// URL-param encoding so back-nav (and shareable links) restore filter state.
// Closes the loop on the gap Phase F surfaced. Only non-default values land
// in the URL — keeps it clean.
function readFilters(sp: URLSearchParams): Filters {
  return {
    module: sp.get('module') ?? '',
    action: sp.get('action') ?? '',
    admin_email: sp.get('admin_email') ?? '',
    entity_type: sp.get('entity_type') ?? '',
    entity_id: sp.get('entity_id') ?? '',
    from: sp.get('from') ?? '',
    to: sp.get('to') ?? '',
    limit: Number(sp.get('limit') ?? '100'),
  };
}
function writeFilters(f: Filters): URLSearchParams {
  const out = new URLSearchParams();
  if (f.module) out.set('module', f.module);
  if (f.action) out.set('action', f.action);
  if (f.admin_email) out.set('admin_email', f.admin_email);
  if (f.entity_type) out.set('entity_type', f.entity_type);
  if (f.entity_id) out.set('entity_id', f.entity_id);
  if (f.from) out.set('from', f.from);
  if (f.to) out.set('to', f.to);
  if (f.limit !== 100) out.set('limit', String(f.limit));
  return out;
}

// ── Page ────────────────────────────────────────────────────────────────

export function AuditPage() {
  const canRead = usePermission('audit.read');
  const [sp, setSp] = useSearchParams();
  const filters = readFilters(sp);
  const [opened, setOpened] = useState<AuditRow | null>(null);

  // Server-side filters: module/action/admin_email/limit. The rest are
  // applied client-side over the fetched page (backend doesn't yet support
  // entity filtering or date range).
  const q = useQuery({
    queryKey: auditKeys.list({
      module: filters.module,
      action: filters.action,
      admin_email: filters.admin_email,
      limit: filters.limit,
    }),
    queryFn: () => listAudit({
      module: filters.module || undefined,
      action: filters.action || undefined,
      admin_email: filters.admin_email || undefined,
      limit: filters.limit,
    }),
    enabled: canRead,
  });

  const filtered = useMemo(() => clientFilter(q.data ?? [], filters), [q.data, filters]);

  const update = (patch: Partial<Filters>) => {
    setSp(writeFilters({ ...filters, ...patch }));
  };
  const clear = () => setSp(new URLSearchParams());

  if (!canRead) {
    return (
      <div className="p-6">
        <EmptyState
          icon={<ShieldAlert className="w-12 h-12" />}
          title="Restricted"
          body="Your role does not have permission to view the audit log."
        />
      </div>
    );
  }

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Audit Log</h1>
          <p className="text-sm text-text-secondary mt-1">
            {q.isLoading ? 'Loading…' : `${filtered.length} entries shown · ${q.data?.length ?? 0} fetched · server cap ${filters.limit}`}
          </p>
        </div>
        <button
          className="btn-ghost"
          onClick={() => q.refetch()}
          disabled={q.isFetching}
          aria-label="refresh"
        >
          <RefreshCw className={`w-4 h-4 ${q.isFetching ? 'animate-spin' : ''}`} />
          Refresh
        </button>
      </div>

      <FiltersBar filters={filters} onChange={update} onClear={clear} />

      {q.isLoading ? (
        <Card>
          <div className="space-y-2">
            {Array.from({ length: 8 }).map((_, i) => <Skeleton key={i} className="h-10" />)}
          </div>
        </Card>
      ) : q.isError ? (
        <Card>
          <EmptyState
            icon={<AlertCircle className="w-12 h-12" />}
            title="Failed to load audit log"
            body="The request errored. Retry or adjust filters."
            action={<button className="btn-primary" onClick={() => q.refetch()}>Retry</button>}
          />
        </Card>
      ) : filtered.length === 0 ? (
        <Card>
          <EmptyState
            icon={<FileText className="w-12 h-12" />}
            title="No audit entries match your filters"
            body="Loosen filters to see more history."
            action={<button className="btn-ghost" onClick={clear}>Clear filters</button>}
          />
        </Card>
      ) : (
        <Card className="!p-0 overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-surface-elevated text-text-muted text-xs uppercase tracking-wider sticky top-0 z-10">
              <tr>
                <Th>Timestamp</Th>
                <Th>Admin</Th>
                <Th>Module</Th>
                <Th>Action</Th>
                <Th>Entity</Th>
                <Th>Preview</Th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((row, i) => (
                <Row key={row.id} row={row} alt={i % 2 === 1} onOpen={() => setOpened(row)} />
              ))}
            </tbody>
          </table>
        </Card>
      )}

      <DetailModal row={opened} onClose={() => setOpened(null)} />
    </div>
  );
}

function clientFilter(rows: AuditRow[], f: Filters): AuditRow[] {
  let out = rows;
  if (f.entity_type) {
    out = out.filter((r) => (r.target_type ?? '') === f.entity_type);
  }
  if (f.entity_id) {
    const q = f.entity_id.toLowerCase();
    out = out.filter((r) => (r.target_id ?? '').toLowerCase().includes(q));
  }
  if (f.from) {
    const fromMs = Date.parse(f.from);
    if (!Number.isNaN(fromMs)) {
      out = out.filter((r) => new Date(r.created_at).getTime() >= fromMs);
    }
  }
  if (f.to) {
    // End-of-day for the chosen date so a single-day filter (from==to) works.
    const toMs = Date.parse(f.to) + 24 * 3600 * 1000;
    if (!Number.isNaN(toMs)) {
      out = out.filter((r) => new Date(r.created_at).getTime() < toMs);
    }
  }
  return out;
}

// ── Filters bar ─────────────────────────────────────────────────────────

function FiltersBar({
  filters, onChange, onClear,
}: { filters: Filters; onChange: (p: Partial<Filters>) => void; onClear: () => void }) {
  return (
    <Card className="!p-4">
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-3">
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-text-muted" />
          <input
            className="input pl-9"
            placeholder="Admin email"
            value={filters.admin_email}
            onChange={(e) => onChange({ admin_email: e.target.value })}
          />
        </div>
        <select
          className="input"
          value={filters.module}
          onChange={(e) => onChange({ module: e.target.value })}
        >
          <option value="">All modules</option>
          {MODULES.map((m) => <option key={m} value={m}>{m}</option>)}
        </select>
        <input
          className="input"
          placeholder="Action (e.g. approve)"
          value={filters.action}
          onChange={(e) => onChange({ action: e.target.value })}
        />
        <select
          className="input"
          value={filters.limit}
          onChange={(e) => onChange({ limit: Number(e.target.value) })}
        >
          {LIMIT_OPTIONS.map((n) => <option key={n} value={n}>Limit {n}</option>)}
        </select>
        <select
          className="input"
          value={filters.entity_type}
          onChange={(e) => onChange({ entity_type: e.target.value })}
        >
          <option value="">All entity types</option>
          {ENTITY_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
        </select>
        <input
          className="input font-mono"
          placeholder="Entity ID (contains)"
          value={filters.entity_id}
          onChange={(e) => onChange({ entity_id: e.target.value })}
        />
        <input
          className="input"
          type="date"
          value={filters.from}
          onChange={(e) => onChange({ from: e.target.value })}
          aria-label="From"
        />
        <input
          className="input"
          type="date"
          value={filters.to}
          onChange={(e) => onChange({ to: e.target.value })}
          aria-label="To"
        />
      </div>
      <div className="mt-3 flex items-center justify-between text-xs text-text-muted">
        <span>
          Date range and entity filters apply client-side. Server-side: module, action, admin_email, limit.
        </span>
        <button className="btn-ghost !py-1 !px-2 text-xs" onClick={onClear}>
          <X className="w-3 h-3" /> Clear filters
        </button>
      </div>
    </Card>
  );
}

// ── Row ─────────────────────────────────────────────────────────────────

function Th({ children }: { children: React.ReactNode }) {
  return <th className="px-4 py-3 font-medium text-left">{children}</th>;
}

function Row({
  row, alt, onOpen,
}: { row: AuditRow; alt: boolean; onOpen: () => void }) {
  return (
    <tr
      className={`border-t border-border cursor-pointer transition ${alt ? 'bg-surface-elevated/40' : ''} hover:bg-primary/5`}
      onClick={onOpen}
    >
      <td className="px-4 py-2.5">
        <div className="text-text-primary text-[13px]">
          {formatDate(new Date(row.created_at), 'MMM d, HH:mm:ss')}
        </div>
        <div className="text-[11px] text-text-muted">
          {formatDistanceToNow(new Date(row.created_at), { addSuffix: true })}
        </div>
      </td>
      <td className="px-4 py-2.5 text-text-primary">
        {row.admin_email ?? <span className="text-text-muted">—</span>}
      </td>
      <td className="px-4 py-2.5">
        <ModulePill module={row.module} />
      </td>
      <td className="px-4 py-2.5">
        <ActionLabel action={row.action} />
      </td>
      <td className="px-4 py-2.5">
        <EntityCell type={row.target_type ?? null} id={row.target_id ?? null} />
      </td>
      <td className="px-4 py-2.5 text-text-secondary text-xs max-w-[260px] truncate">
        {previewDetails(row)}
      </td>
    </tr>
  );
}

function ModulePill({ module }: { module: string }) {
  // Soft colour-coding by module — keeps the table scannable without
  // dragging every module into its own bucket. Buckets are loose, not
  // semantic guarantees.
  const tone: 'success' | 'warning' | 'danger' | 'info' | 'neutral' =
    module === 'workers' || module === 'zone-approvals' ? 'info'
    : module === 'orders' || module === 'refunds' ? 'success'
    : module === 'flags' || module === 'webhooks' || module === 'platform' ? 'warning'
    : module === 'blacklist' || module === 'fraud' ? 'danger'
    : 'neutral';
  return <StatusPill tone={tone}>{module}</StatusPill>;
}

function ActionLabel({ action }: { action: string }) {
  const verb = action.split('.').pop() ?? action;
  let cls = 'text-text-primary';
  if (verb.includes('create') || verb.includes('add') || verb.includes('approve')) cls = 'text-success';
  else if (verb.includes('delete') || verb.includes('reject') || verb.includes('ban') || verb.includes('cancel')) cls = 'text-danger';
  else if (verb.includes('update') || verb.includes('set') || verb.includes('rotate')) cls = 'text-primary';
  return <span className={`font-mono text-[12px] ${cls}`}>{action}</span>;
}

function EntityCell({ type, id }: { type: string | null; id: string | null }) {
  if (!type && !id) return <span className="text-text-muted">—</span>;
  const linkPath = entityLink(type, id);
  const label = (
    <>
      {type && <span className="text-text-secondary">{type}</span>}
      {id && <span className="font-mono text-[11px] text-text-muted ml-1.5">{id.slice(0, 8)}</span>}
    </>
  );
  if (!linkPath) return <span>{label}</span>;
  return (
    <Link
      to={linkPath}
      className="hover:text-primary"
      onClick={(e) => e.stopPropagation()}
    >
      {label}
    </Link>
  );
}

function entityLink(type: string | null, id: string | null): string | null {
  if (!type || !id) return null;
  switch (type) {
    case 'worker': return `/workers?id=${id}`;
    case 'order':  return `/orders/${id}`;
    case 'user':   return `/users?id=${id}`;
    case 'zone_approval_request': return `/zone-approvals`;
    case 'refund': return `/refunds?id=${id}`;
    default: return null;
  }
}

function previewDetails(row: AuditRow): string {
  // Compact one-line preview of whichever side carries data. Strip braces,
  // trim ws so the table cell stays compact.
  const src = row.after ?? row.before;
  if (src == null) return '';
  try {
    const s = typeof src === 'string' ? src : JSON.stringify(src);
    return s.length > 140 ? `${s.slice(0, 140)}…` : s;
  } catch {
    return '';
  }
}

// ── Detail modal ────────────────────────────────────────────────────────

function DetailModal({ row, onClose }: { row: AuditRow | null; onClose: () => void }) {
  const copy = () => {
    if (!row) return;
    void navigator.clipboard.writeText(JSON.stringify(row, null, 2));
    showToast({ kind: 'success', message: 'Copied to clipboard.' });
  };

  return (
    <Modal open={row != null} onClose={onClose} title="Audit entry" width="max-w-3xl">
      {row && (
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-3 text-sm">
            <KV k="Timestamp" v={formatDate(new Date(row.created_at), 'MMM d, yyyy HH:mm:ss')} />
            <KV k="ID" v={String(row.id)} mono />
            <KV k="Admin" v={row.admin_email ?? '—'} />
            <KV k="IP" v={row.ip_address ?? '—'} mono />
            <KV k="Module" v={row.module} />
            <KV k="Action" v={row.action} mono />
            <KV k="Entity type" v={row.target_type ?? '—'} />
            <KV k="Entity ID" v={row.target_id ?? '—'} mono />
          </div>
          <JsonBlock title="Before" value={row.before} />
          <JsonBlock title="After" value={row.after} />
          <div className="flex justify-end">
            <button className="btn-ghost" onClick={copy}>
              <Copy className="w-4 h-4" />
              Copy JSON
            </button>
          </div>
        </div>
      )}
    </Modal>
  );
}

function KV({ k, v, mono }: { k: string; v: string; mono?: boolean }) {
  return (
    <div className="flex items-baseline gap-2">
      <span className="text-text-muted text-xs uppercase tracking-wider min-w-[100px]">{k}</span>
      <span className={`text-text-primary break-all ${mono ? 'font-mono text-[12px]' : ''}`}>{v}</span>
    </div>
  );
}

function JsonBlock({ title, value }: { title: string; value: unknown }) {
  const [open, setOpen] = useState(true);
  if (value == null || (typeof value === 'object' && value && Object.keys(value as object).length === 0)) {
    return (
      <div>
        <div className="text-xs uppercase tracking-wider text-text-muted mb-1">{title}</div>
        <div className="card-elevated p-3 text-xs text-text-secondary">empty</div>
      </div>
    );
  }
  return (
    <div>
      <button
        className="text-xs uppercase tracking-wider text-text-muted mb-1 inline-flex items-center gap-1 hover:text-text-primary"
        onClick={() => setOpen((v) => !v)}
      >
        <ChevronDown className={`w-3 h-3 transition ${open ? '' : '-rotate-90'}`} />
        {title}
      </button>
      {open && (
        <pre className="card-elevated p-3 text-[11px] font-mono text-text-primary whitespace-pre-wrap break-all max-h-[280px] overflow-y-auto">
          {prettyJson(value)}
        </pre>
      )}
    </div>
  );
}

function prettyJson(v: unknown): string {
  try {
    if (typeof v === 'string') {
      // Backend may emit either a JSON string or a stringified JSON value.
      // Try to re-parse for prettier display; fall back to the literal.
      try { return JSON.stringify(JSON.parse(v), null, 2); } catch { return v; }
    }
    return JSON.stringify(v, null, 2);
  } catch {
    return String(v);
  }
}
