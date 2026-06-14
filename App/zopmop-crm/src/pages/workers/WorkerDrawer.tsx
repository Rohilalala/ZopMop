import { useEffect, useState } from 'react';
import {
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { format, formatDistanceToNow } from 'date-fns';
import {
  AlertTriangle,
  Bell,
  BadgeCheck,
  Briefcase,
  CalendarDays,
  CheckCircle2,
  Eye,
  EyeOff,
  IndianRupee,
  Star,
} from 'lucide-react';
import { useNavigate } from 'react-router-dom';

import {
  addDeduction,
  approveWorker,
  forceOffline,
  getWorker,
  getWorkerJobs,
  listDeductions,
  rejectWorker,
  setWorkerCategories,
  setWorkerLocality,
  suspendWorker,
  unsuspendWorker,
  workerActiveJob,
  workerPII,
  type WorkerPII,
  workerKeys,
  type Status,
  type WorkerDetail,
} from '@/api/workers';
import { allocateLeave, getBalances } from '@/api/leaves';
import {
  getWorkerPayouts,
  getWorkerPerformance,
  markPayoutFailed,
  markPayoutPaid,
  payrollKeys,
  performanceKeys,
  recomputePayout,
  reviewFlag,
  type FlagReviewAction,
  type HelperFlag,
  type Payout,
  type PayoutStatus,
} from '@/api/payroll';
import { listLocalities } from '@/api/localities';
import { growthApi } from '@/api/all';
import { Can } from '@/auth/Can';
import { Card, EmptyState, Skeleton, StatusPill } from '@/components/ui';
import { Drawer } from '@/components/ui/Drawer';
import { ConfirmModal, Modal } from '@/components/ui/Modal';
import { showToast } from '@/components/ui/Toast';
import { formatRupees, formatRupeesExact } from '@/lib/formatters';

// WorkerDrawer — full 4-tab worker detail panel. Rebuilt from scratch after
// Phase D's reported 803-LOC implementation turned out to be an empty commit
// (89f568f shipped 0 bytes; a317839 stubbed it so CI could pass).
//
// Every API contract here was verified against src/api/*.ts before use — no
// invented fields. Where the WorkerDetail payload lacks something the Phase D
// spec asked for (email, weekly_hours_target), the row is omitted rather than
// faked: Fiber's struct unmarshal silently drops unknown keys, so a fabricated
// field would make the UI lie about what is actually persisted.

type TabId = 'profile' | 'performance' | 'actions' | 'deductions' | 'payouts' | 'targets';

const TABS: { id: TabId; label: string }[] = [
  { id: 'profile', label: 'Profile' },
  { id: 'performance', label: 'Performance' },
  { id: 'targets', label: 'Targets & flags' },
  { id: 'actions', label: 'Actions' },
  { id: 'deductions', label: 'Deductions' },
  { id: 'payouts', label: 'Payouts' },
];

// Mirrors WorkerNewPage's CATEGORY_OPTIONS. Kept local rather than imported so
// the drawer doesn't pull the whole registration page into its chunk.
const CATEGORY_OPTIONS: { value: string; label: string }[] = [
  { value: 'utensils', label: 'Utensils' },
  { value: 'sweep_mop', label: 'Sweep & Mop' },
  { value: 'dusting', label: 'Dusting' },
  { value: 'bathroom', label: 'Bathroom' },
  { value: 'kitchen_prep', label: 'Kitchen Prep' },
  { value: 'laundry', label: 'Laundry' },
  { value: 'ironing', label: 'Ironing' },
  { value: 'balcony', label: 'Balcony' },
];

const STATUS_TONE: Record<Status, 'success' | 'warning' | 'danger' | 'neutral'> = {
  active: 'success',
  pending: 'warning',
  rejected: 'danger',
  suspended: 'danger',
  banned: 'danger',
};

function cap(s: string | null | undefined): string {
  if (!s) return '—';
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function fmtDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '—' : format(d, 'MMM d, yyyy');
}

function fmtRel(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? '—'
    : formatDistanceToNow(d, { addSuffix: true });
}

// Mask all but the last 4 digits, grouping the X prefix into the bank/aadhaar
// shape the spec asked for. The visible suffix is the last 4 of the raw value.
function maskTail(raw: string | null | undefined, groups: number[]): string {
  if (!raw) return '—';
  const last4 = raw.slice(-4);
  const prefix = groups.map((n) => 'X'.repeat(n)).join('-');
  return `${prefix}-${last4}`;
}

function shortId(id: string): string {
  return id.length > 8 ? id.slice(0, 8) : id;
}

export function WorkerDrawer({
  workerId,
  onClose,
}: {
  workerId: string | null;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [tab, setTab] = useState<TabId>('profile');

  // Reset to the first tab whenever a different worker is opened.
  useEffect(() => {
    setTab('profile');
  }, [workerId]);

  const detailQ = useQuery({
    queryKey: workerId
      ? workerKeys.detail(workerId)
      : ['workers', 'detail', 'none'],
    queryFn: () => getWorker(workerId as string),
    enabled: !!workerId,
  });

  const worker = detailQ.data;

  return (
    <Drawer open={workerId != null} onClose={onClose}>
      <div className="flex flex-col h-full">
        {detailQ.isLoading && (
          <div className="p-6 space-y-4">
            <Skeleton className="h-16 w-full" />
            <Skeleton className="h-8 w-2/3" />
            <Skeleton className="h-40 w-full" />
            <Skeleton className="h-40 w-full" />
          </div>
        )}

        {detailQ.isError && (
          <div className="p-6">
            <EmptyState
              icon={<AlertTriangle className="w-8 h-8" />}
              title="Worker not found"
              body="Stale link — this worker may have been removed, or the id in the URL is no longer valid."
            />
          </div>
        )}

        {worker && (
          <>
            <Header worker={worker} />

            <div className="px-6 border-b border-border flex gap-1">
              {TABS.map((t) => (
                <button
                  key={t.id}
                  onClick={() => setTab(t.id)}
                  className={`px-3 py-2.5 text-sm font-medium border-b-2 transition -mb-px ${
                    tab === t.id
                      ? 'border-primary text-text-primary'
                      : 'border-transparent text-text-muted hover:text-text-secondary'
                  }`}
                >
                  {t.label}
                </button>
              ))}
            </div>

            <div className="flex-1 overflow-y-auto p-6 space-y-5">
              {tab === 'profile' && <ProfileTab worker={worker} qc={qc} />}
              {tab === 'performance' && (
                <PerformanceTab worker={worker} navigate={navigate} />
              )}
              {tab === 'actions' && <ActionsTab worker={worker} qc={qc} />}
              {tab === 'deductions' && (
                <DeductionsTab workerId={worker.id} />
              )}
              {tab === 'payouts' && (
                <PayoutsTab workerId={worker.id} workerName={worker.name ?? null} />
              )}
              {tab === 'targets' && (
                <TargetsTab workerId={worker.id} />
              )}
            </div>
          </>
        )}
      </div>
    </Drawer>
  );
}

// ──────────────────────────────────────────────────────────────────────────
// Header
// ──────────────────────────────────────────────────────────────────────────

function Header({ worker }: { worker: WorkerDetail }) {
  const initial = (worker.name?.trim()?.[0] ?? '?').toUpperCase();
  return (
    <div className="p-6 pr-12 flex items-start gap-4 border-b border-border">
      <div className="w-12 h-12 rounded-full bg-surface-elevated border border-border flex items-center justify-center text-lg font-semibold text-text-primary shrink-0">
        {initial}
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 flex-wrap">
          <h2 className="text-lg font-semibold text-text-primary truncate">
            {worker.name || 'Unnamed worker'}
          </h2>
          <StatusPill tone={STATUS_TONE[worker.status]}>
            {cap(worker.status)}
          </StatusPill>
          {worker.is_online && <StatusPill tone="success">Online</StatusPill>}
        </div>
        <p className="text-sm text-text-secondary mt-1">{worker.phone}</p>
        <p className="text-xs text-text-muted mt-0.5">
          {worker.locality || 'No locality set'}
        </p>
      </div>
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────────────
// Shared bits
// ──────────────────────────────────────────────────────────────────────────

function Field({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex justify-between gap-4 py-1.5 text-sm">
      <span className="text-text-muted shrink-0">{label}</span>
      <span className="text-text-primary text-right break-words">{value}</span>
    </div>
  );
}

function Chips({ items }: { items: string[] }) {
  if (!items.length) return <span className="text-text-primary">—</span>;
  return (
    <span className="flex flex-wrap gap-1 justify-end">
      {items.map((c) => (
        <span
          key={c}
          className="pill border-border text-text-secondary bg-surface-elevated"
        >
          {CATEGORY_OPTIONS.find((o) => o.value === c)?.label ?? c}
        </span>
      ))}
    </span>
  );
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <h3 className="text-xs uppercase tracking-wider text-text-muted mb-3">
      {children}
    </h3>
  );
}

// ──────────────────────────────────────────────────────────────────────────
// Tab 1 — Profile
// ──────────────────────────────────────────────────────────────────────────

function ProfileTab({
  worker,
  qc,
}: {
  worker: WorkerDetail;
  qc: ReturnType<typeof useQueryClient>;
}) {
  const [showAadhaar, setShowAadhaar] = useState(false);
  const [showBank, setShowBank] = useState(false);
  // Unmasked PII is never shipped in the worker detail payload (C7) — it is
  // fetched on demand from the superadmin-only, server-audited reveal endpoint.
  const [pii, setPii] = useState<WorkerPII | null>(null);
  const piiMut = useMutation({
    mutationFn: () => workerPII(worker.id),
    onSuccess: (data) => setPii(data),
  });
  function toggleReveal(which: 'aadhaar' | 'bank') {
    if (!pii && !piiMut.isPending) piiMut.mutate(); // one audited fetch
    if (which === 'aadhaar') setShowAadhaar((v) => !v);
    else setShowBank((v) => !v);
  }
  const [editLoc, setEditLoc] = useState(false);
  const [editCats, setEditCats] = useState(false);

  const [reasonModal, setReasonModal] = useState<null | 'suspend' | 'reject'>(
    null,
  );
  const [reason, setReason] = useState('');
  const [confirm, setConfirm] = useState<
    null | 'unsuspend' | 'approve' | 'offline'
  >(null);

  const invalidate = () =>
    qc.invalidateQueries({ queryKey: workerKeys.detail(worker.id) });

  const localitiesQ = useQuery({
    queryKey: ['localities', 'active'],
    queryFn: () => listLocalities({ activeOnly: true }),
    enabled: editLoc,
  });

  const locMut = useMutation({
    mutationFn: (loc: string) => setWorkerLocality(worker.id, loc),
    onSuccess: (canonical) => {
      showToast({
        kind: 'success',
        message: `Locality set to ${canonical || '—'}`,
      });
      setEditLoc(false);
      invalidate();
    },
  });

  const catMut = useMutation({
    mutationFn: (cats: string[]) => setWorkerCategories(worker.id, cats),
    onSuccess: () => {
      showToast({ kind: 'success', message: 'Categories updated' });
      setEditCats(false);
      invalidate();
    },
  });

  const lifecycleMut = useMutation({
    mutationFn: async (
      kind: 'suspend' | 'reject' | 'unsuspend' | 'approve' | 'offline',
    ) => {
      if (kind === 'suspend') return suspendWorker(worker.id, reason);
      if (kind === 'reject') return rejectWorker(worker.id, reason);
      if (kind === 'unsuspend') return unsuspendWorker(worker.id);
      if (kind === 'approve') return approveWorker(worker.id);
      return forceOffline(worker.id);
    },
    onSuccess: (_d, kind) => {
      showToast({ kind: 'success', message: `Worker ${kind} done` });
      setReason('');
      setReasonModal(null);
      setConfirm(null);
      invalidate();
    },
    onError: (err: unknown) => {
      // Server errors that carry a message (e.g. the force-offline
      // active-job 409) are already toasted by the axios interceptor — don't
      // mask them with a generic toast. Only fall back for network errors.
      const data = (err as { response?: { data?: { message?: string; error?: string } } })?.response?.data;
      if (!data?.message && !data?.error) {
        showToast({ kind: 'error', message: 'Action failed — try again' });
      }
    },
  });

  // When the force-offline confirm is open, check for an in-flight job so we
  // can warn the admin up front (the server also blocks it with a 409).
  const activeJobQ = useQuery({
    queryKey: ['worker-active-job', worker.id],
    queryFn: () => workerActiveJob(worker.id),
    enabled: confirm === 'offline',
  });

  const [catDraft, setCatDraft] = useState<string[]>(worker.categories);
  useEffect(() => setCatDraft(worker.categories), [worker.categories]);

  return (
    <div className="space-y-5">
      <Card>
        <SectionTitle>Personal Info</SectionTitle>
        <Field label="Name" value={worker.name || '—'} />
        <Field label="Date of birth" value={fmtDate(worker.dob)} />
        <Field label="Gender" value={cap(worker.gender)} />
        <Field
          label="Languages"
          value={<Chips items={worker.languages ?? []} />}
        />
      </Card>

      <Card>
        <SectionTitle>Contact Info</SectionTitle>
        <Field label="Phone" value={worker.phone} />
        <Field label="Alt phone" value={worker.alt_phone || '—'} />
        <Field label="Address" value={worker.address || '—'} />
        <Field
          label="Emergency contact"
          value={
            worker.emergency_contact_name || worker.emergency_contact_phone
              ? `${worker.emergency_contact_name || '—'} · ${
                  worker.emergency_contact_phone || '—'
                }`
              : '—'
          }
        />
      </Card>

      <Card>
        <SectionTitle>Work Info</SectionTitle>

        <div className="flex justify-between gap-4 py-1.5 text-sm items-start">
          <span className="text-text-muted shrink-0">Locality</span>
          {editLoc ? (
            <div className="flex flex-col items-end gap-2">
              <select
                className="input"
                defaultValue={worker.locality ?? ''}
                onChange={(e) => locMut.mutate(e.target.value)}
                disabled={locMut.isPending || localitiesQ.isLoading}
              >
                <option value="">— Clear —</option>
                {(localitiesQ.data ?? []).map((l) => (
                  <option key={l.id} value={l.name}>
                    {l.name} ({l.city})
                  </option>
                ))}
              </select>
              <button
                className="btn-ghost !py-1 !px-2 text-xs"
                onClick={() => setEditLoc(false)}
              >
                Cancel
              </button>
            </div>
          ) : (
            <span className="text-text-primary text-right">
              {worker.locality || '—'}{' '}
              <button
                className="text-primary text-xs ml-2"
                onClick={() => setEditLoc(true)}
              >
                Edit
              </button>
            </span>
          )}
        </div>

        <div className="flex justify-between gap-4 py-1.5 text-sm items-start">
          <span className="text-text-muted shrink-0">Categories</span>
          {editCats ? (
            <div className="flex flex-col items-end gap-2">
              <div className="flex flex-wrap gap-1.5 justify-end max-w-xs">
                {CATEGORY_OPTIONS.map((c) => {
                  const on = catDraft.includes(c.value);
                  return (
                    <button
                      key={c.value}
                      onClick={() =>
                        setCatDraft((d) =>
                          on
                            ? d.filter((x) => x !== c.value)
                            : [...d, c.value],
                        )
                      }
                      className={`pill ${
                        on
                          ? 'border-primary/30 text-primary/90 bg-primary/10'
                          : 'border-border text-text-muted bg-surface-elevated'
                      }`}
                    >
                      {c.label}
                    </button>
                  );
                })}
              </div>
              <div className="flex gap-2">
                <button
                  className="btn-ghost !py-1 !px-2 text-xs"
                  onClick={() => {
                    setCatDraft(worker.categories);
                    setEditCats(false);
                  }}
                >
                  Cancel
                </button>
                <button
                  className="btn-primary !py-1 !px-2 text-xs"
                  disabled={catMut.isPending}
                  onClick={() => catMut.mutate(catDraft)}
                >
                  {catMut.isPending ? 'Saving…' : 'Save'}
                </button>
              </div>
            </div>
          ) : (
            <span className="text-text-primary text-right inline-flex items-center gap-2">
              <Chips items={worker.categories} />
              <button
                className="text-primary text-xs"
                onClick={() => setEditCats(true)}
              >
                Edit
              </button>
            </span>
          )}
        </div>

        <Field
          label="Approval status"
          value={
            <StatusPill tone={STATUS_TONE[worker.status]}>
              {cap(worker.status)}
            </StatusPill>
          }
        />
      </Card>

      {/* PII — visually separated, handled with care. */}
      <div className="rounded-lg border border-warning/20 bg-warning/5 p-5 space-y-4">
        <div className="flex items-center gap-2 text-warning">
          <AlertTriangle className="w-4 h-4" />
          <h3 className="text-xs uppercase tracking-wider font-semibold">
            PII — handle carefully
          </h3>
        </div>

        <div className="space-y-1.5">
          <div className="flex justify-between gap-4 text-sm items-center">
            <span className="text-text-muted">Aadhaar</span>
            <span className="flex items-center gap-2 text-text-primary font-mono">
              {showAadhaar
                ? pii?.aadhaar_number || '—'
                : maskTail(worker.aadhaar_number, [4, 4])}
              {worker.aadhaar_number && (
                <Can perm="workers.read_pii">
                  <button
                    onClick={() => toggleReveal('aadhaar')}
                    disabled={piiMut.isPending}
                    className="text-text-muted hover:text-text-primary"
                    aria-label="reveal aadhaar"
                  >
                    {showAadhaar ? (
                      <EyeOff className="w-4 h-4" />
                    ) : (
                      <Eye className="w-4 h-4" />
                    )}
                  </button>
                </Can>
              )}
              {worker.aadhaar_verified ? (
                <CheckCircle2 className="w-4 h-4 text-success" />
              ) : (
                <AlertTriangle className="w-4 h-4 text-warning" />
              )}
            </span>
          </div>

          <Field
            label="Bank holder"
            value={worker.bank_account_holder_name || '—'}
          />

          <div className="flex justify-between gap-4 text-sm items-center">
            <span className="text-text-muted">Bank account</span>
            <span className="flex items-center gap-2 text-text-primary font-mono">
              {showBank
                ? pii?.bank_account_number || '—'
                : maskTail(worker.bank_account_number, [3, 4])}
              {worker.bank_account_number && (
                <Can perm="workers.read_pii">
                  <button
                    onClick={() => toggleReveal('bank')}
                    disabled={piiMut.isPending}
                    className="text-text-muted hover:text-text-primary"
                    aria-label="reveal bank account"
                  >
                    {showBank ? (
                      <EyeOff className="w-4 h-4" />
                    ) : (
                      <Eye className="w-4 h-4" />
                    )}
                  </button>
                </Can>
              )}
              {worker.bank_verified ? (
                <CheckCircle2 className="w-4 h-4 text-success" />
              ) : (
                <AlertTriangle className="w-4 h-4 text-warning" />
              )}
            </span>
          </div>

          <Field label="IFSC" value={worker.bank_ifsc || '—'} />
        </div>

        {worker.photo_url && (
          <a
            href={worker.photo_url}
            target="_blank"
            rel="noreferrer"
            className="inline-block"
          >
            <img
              src={worker.photo_url}
              alt="worker"
              className="w-20 h-20 rounded object-cover border border-border"
            />
          </a>
        )}

        <p className="text-xs text-text-muted">
          Reveal is local to this view — no audit endpoint yet (Phase 12 P0).
        </p>
      </div>

      {/* Lifecycle action buttons */}
      <div className="flex flex-wrap gap-2">
        {worker.status === 'active' && (
          <button
            className="btn-danger"
            onClick={() => setReasonModal('suspend')}
          >
            Suspend
          </button>
        )}
        {worker.status === 'suspended' && (
          <button
            className="btn-primary"
            onClick={() => setConfirm('unsuspend')}
          >
            Reactivate
          </button>
        )}
        {worker.status === 'pending' && (
          <>
            <button
              className="btn-primary"
              onClick={() => setConfirm('approve')}
            >
              Approve
            </button>
            <button
              className="btn-danger"
              onClick={() => setReasonModal('reject')}
            >
              Reject
            </button>
          </>
        )}
        {worker.is_online && (
          <button
            className="btn-ghost"
            onClick={() => setConfirm('offline')}
          >
            Force offline
          </button>
        )}
      </div>

      {/* Reason prompt for suspend / reject (free-text, so not ConfirmModal) */}
      <Modal
        open={reasonModal != null}
        onClose={() => {
          setReasonModal(null);
          setReason('');
        }}
        title={reasonModal === 'reject' ? 'Reject worker' : 'Suspend worker'}
      >
        <p className="text-sm text-text-secondary mb-4">
          This is logged against your admin id. Provide a reason.
        </p>
        <textarea
          className="input min-h-[90px] w-full"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder="Reason"
        />
        <div className="flex justify-end gap-2 mt-4">
          <button
            className="btn-ghost"
            onClick={() => {
              setReasonModal(null);
              setReason('');
            }}
          >
            Cancel
          </button>
          <button
            className="btn-danger"
            disabled={reason.trim().length < 3 || lifecycleMut.isPending}
            onClick={() =>
              lifecycleMut.mutate(reasonModal as 'suspend' | 'reject')
            }
          >
            {lifecycleMut.isPending ? 'Working…' : 'Confirm'}
          </button>
        </div>
      </Modal>

      <ConfirmModal
        open={confirm != null}
        onClose={() => setConfirm(null)}
        onConfirm={() =>
          lifecycleMut.mutateAsync(
            confirm as 'unsuspend' | 'approve' | 'offline',
          )
        }
        title={
          confirm === 'approve'
            ? 'Approve worker'
            : confirm === 'unsuspend'
              ? 'Reactivate worker'
              : 'Force worker offline'
        }
        impact={
          confirm === 'approve'
            ? 'Worker can start receiving jobs immediately.'
            : confirm === 'unsuspend'
              ? 'Worker returns to active and can be matched again.'
              : activeJobQ.data?.has_active
                ? `⚠ This worker has an active job${activeJobQ.data.booking_id ? ` (booking ${activeJobQ.data.booking_id})` : ''}. Forcing them offline is blocked until that job is reassigned or completed.`
                : 'Worker is pushed offline and drops out of matching until they re-open the app.'
        }
        confirmLabel="Confirm"
        destructive={confirm === 'offline'}
      />
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────────────
// Tab 2 — Performance
// ──────────────────────────────────────────────────────────────────────────

function Stat({
  icon,
  label,
  value,
}: {
  icon: React.ReactNode;
  label: string;
  value: React.ReactNode;
}) {
  return (
    <div className="card p-4">
      <div className="flex items-center gap-1.5 text-text-muted text-xs mb-1">
        {icon}
        {label}
      </div>
      <div className="text-lg font-semibold text-text-primary">{value}</div>
    </div>
  );
}

function PerformanceTab({
  worker,
  navigate,
}: {
  worker: WorkerDetail;
  navigate: ReturnType<typeof useNavigate>;
}) {
  const activeQ = useQuery({
    queryKey: ['workers', worker.id, 'active-job'],
    queryFn: () => workerActiveJob(worker.id),
  });

  const jobsQ = useQuery({
    queryKey: ['workers', worker.id, 'jobs'],
    queryFn: () => getWorkerJobs(worker.id),
  });

  const jobs = (jobsQ.data ?? []).slice(0, 10);

  return (
    <div className="space-y-5">
      {activeQ.data?.has_active && activeQ.data.booking_id && (
        <button
          onClick={() => navigate(`/orders/${activeQ.data!.booking_id}`)}
          className="w-full text-left rounded-lg border border-success/30 bg-success/10 px-4 py-3 text-sm text-success/90 hover:bg-success/15 transition"
        >
          Currently working — view active order →
        </button>
      )}

      <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
        <Stat
          icon={<Star className="w-3.5 h-3.5" />}
          label="Rating"
          value={worker.rating != null ? worker.rating.toFixed(1) : '—'}
        />
        <Stat
          icon={<Briefcase className="w-3.5 h-3.5" />}
          label="Total jobs"
          value={worker.total_jobs ?? '—'}
        />
        <Stat
          icon={<CheckCircle2 className="w-3.5 h-3.5" />}
          label="Completed (30d)"
          value={worker.completed_jobs_30d ?? '—'}
        />
        <Stat
          icon={<IndianRupee className="w-3.5 h-3.5" />}
          label="Earnings (30d)"
          value={formatRupees(worker.earnings_30d_cents)}
        />
        <Stat
          icon={<AlertTriangle className="w-3.5 h-3.5" />}
          label="Cancellation rate"
          value={
            worker.cancellation_rate != null
              ? `${(worker.cancellation_rate * 100).toFixed(1)}%`
              : '—'
          }
        />
        <Stat
          icon={<CalendarDays className="w-3.5 h-3.5" />}
          label="Joined"
          value={fmtRel(worker.joined_at)}
        />
      </div>

      <Card>
        <SectionTitle>Recent Jobs</SectionTitle>
        {jobsQ.isLoading && <Skeleton className="h-24 w-full" />}
        {!jobsQ.isLoading && jobs.length === 0 && (
          <EmptyState title="No completed jobs yet" />
        )}
        {jobs.length > 0 && (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-text-muted text-xs">
                <tr className="text-left">
                  <th className="py-2 pr-3">Booking</th>
                  <th className="py-2 pr-3">Category</th>
                  <th className="py-2 pr-3">Status</th>
                  <th className="py-2 pr-3">Completed</th>
                  <th className="py-2 text-right">Amount</th>
                </tr>
              </thead>
              <tbody>
                {jobs.map((j) => (
                  <tr
                    key={j.id}
                    onClick={() => navigate(`/orders/${j.id}`)}
                    className="border-t border-border cursor-pointer hover:bg-surface-elevated"
                  >
                    <td className="py-2 pr-3 font-mono">{shortId(j.id)}</td>
                    <td className="py-2 pr-3">
                      {CATEGORY_OPTIONS.find((o) => o.value === j.category)
                        ?.label ?? j.category}
                    </td>
                    <td className="py-2 pr-3">
                      <StatusPill
                        tone={
                          j.status === 'completed' ? 'success' : 'neutral'
                        }
                      >
                        {cap(j.status)}
                      </StatusPill>
                    </td>
                    <td className="py-2 pr-3 text-text-secondary">
                      {fmtRel(j.completed_at ?? j.created_at)}
                    </td>
                    <td className="py-2 text-right">
                      {formatRupees(j.price_paise)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────────────
// Tab 3 — Actions
// ──────────────────────────────────────────────────────────────────────────

const deductionSchema = z.object({
  amount: z.coerce.number().positive('Amount must be greater than 0'),
  reason: z.string().trim().min(5, 'Reason must be at least 5 characters'),
  fortnight_start: z.string().optional(),
});
type DeductionForm = z.input<typeof deductionSchema>;

const leaveSchema = z.object({
  days: z.coerce
    .number()
    .int()
    .refine((n) => n !== 0, 'Days cannot be 0'),
  reason: z.string().trim().min(5, 'Reason must be at least 5 characters'),
});
type LeaveForm = z.input<typeof leaveSchema>;

const pushSchema = z.object({
  title: z.string().trim().min(1).max(80),
  body: z.string().trim().min(1).max(240),
});
type PushForm = z.input<typeof pushSchema>;

function ActionsTab({
  worker,
  qc,
}: {
  worker: WorkerDetail;
  qc: ReturnType<typeof useQueryClient>;
}) {
  return (
    <div className="space-y-5">
      <Can perm="workers.deduct">
        <DeductionCard workerId={worker.id} qc={qc} />
      </Can>
      <Can perm="workers.update">
        <LeaveCard workerId={worker.id} qc={qc} />
      </Can>
      <Can perm="push.send">
        <PushCard worker={worker} />
      </Can>
    </div>
  );
}

function DeductionCard({
  workerId,
  qc,
}: {
  workerId: string;
  qc: ReturnType<typeof useQueryClient>;
}) {
  const {
    register,
    handleSubmit,
    reset,
    formState: { errors },
  } = useForm<DeductionForm>({
    resolver: zodResolver(deductionSchema),
  });

  const mut = useMutation({
    mutationFn: (v: DeductionForm) =>
      addDeduction(workerId, {
        amount_paise: Math.round(Number(v.amount) * 100),
        reason: String(v.reason),
        fortnight_start: v.fortnight_start || undefined,
      }),
    onSuccess: (_d, v) => {
      showToast({
        kind: 'success',
        message: `Deduction of ₹${Number(v.amount)} applied`,
      });
      reset();
      qc.invalidateQueries({ queryKey: workerKeys.deductions(workerId) });
      qc.invalidateQueries({ queryKey: workerKeys.detail(workerId) });
    },
    onError: () =>
      showToast({ kind: 'error', message: 'Deduction failed — try again' }),
  });

  return (
    <Card>
      <SectionTitle>Manual Deduction</SectionTitle>
      <form className="space-y-3" onSubmit={handleSubmit((v) => mut.mutate(v))}>
        <div>
          <label className="block text-xs text-text-muted mb-1">
            Amount (₹)
          </label>
          <input
            type="number"
            step="0.01"
            className="input w-full"
            {...register('amount')}
          />
          {errors.amount && (
            <p className="text-xs text-danger mt-1">
              {errors.amount.message}
            </p>
          )}
        </div>
        <div>
          <label className="block text-xs text-text-muted mb-1">Reason</label>
          <textarea
            className="input w-full min-h-[70px]"
            {...register('reason')}
          />
          {errors.reason && (
            <p className="text-xs text-danger mt-1">
              {errors.reason.message}
            </p>
          )}
        </div>
        <div>
          <label className="block text-xs text-text-muted mb-1">
            Fortnight start (optional)
          </label>
          <input
            type="date"
            className="input w-full"
            {...register('fortnight_start')}
          />
        </div>
        <button
          className="btn-primary w-full"
          disabled={mut.isPending}
          type="submit"
        >
          {mut.isPending ? 'Applying…' : 'Apply deduction'}
        </button>
      </form>
    </Card>
  );
}

function LeaveCard({
  workerId,
  qc,
}: {
  workerId: string;
  qc: ReturnType<typeof useQueryClient>;
}) {
  const {
    register,
    handleSubmit,
    watch,
    reset,
    formState: { errors },
  } = useForm<LeaveForm>({ resolver: zodResolver(leaveSchema) });

  const [pendingNeg, setPendingNeg] = useState<LeaveForm | null>(null);

  const balQ = useQuery({
    queryKey: ['leaves', 'balance', workerId],
    queryFn: () => getBalances(workerId),
  });
  const balance = balQ.data?.[0]?.balance ?? null;

  const days = Number(watch('days') || 0);

  const mut = useMutation({
    mutationFn: (v: LeaveForm) =>
      allocateLeave(workerId, Number(v.days), String(v.reason)),
    onSuccess: (res) => {
      showToast({
        kind: 'success',
        message: `New balance: ${res.new_balance} days`,
      });
      reset();
      setPendingNeg(null);
      qc.invalidateQueries({ queryKey: ['leaves', 'balance', workerId] });
      qc.invalidateQueries({ queryKey: workerKeys.detail(workerId) });
    },
    onError: () =>
      showToast({ kind: 'error', message: 'Leave adjustment failed' }),
  });

  function submit(v: LeaveForm) {
    if (Number(v.days) < 0) {
      setPendingNeg(v);
      return;
    }
    mut.mutate(v);
  }

  return (
    <Card>
      <SectionTitle>Leave Adjustment</SectionTitle>
      <form className="space-y-3" onSubmit={handleSubmit(submit)}>
        <div>
          <label className="block text-xs text-text-muted mb-1">
            Days (+ grant / − deduct)
          </label>
          <input
            type="number"
            step="1"
            className={`input w-full ${
              days > 0 ? 'text-success' : days < 0 ? 'text-danger' : ''
            }`}
            {...register('days')}
          />
          {errors.days && (
            <p className="text-xs text-danger mt-1">{errors.days.message}</p>
          )}
        </div>
        <div>
          <label className="block text-xs text-text-muted mb-1">Reason</label>
          <textarea
            className="input w-full min-h-[70px]"
            {...register('reason')}
          />
          {errors.reason && (
            <p className="text-xs text-danger mt-1">
              {errors.reason.message}
            </p>
          )}
        </div>
        <button
          className="btn-primary w-full"
          disabled={mut.isPending}
          type="submit"
        >
          {mut.isPending ? 'Saving…' : 'Apply adjustment'}
        </button>
      </form>
      <p className="text-xs text-text-muted mt-3">
        Current leave balance:{' '}
        <span className="text-text-primary font-medium">
          {balQ.isLoading
            ? '…'
            : balance != null
              ? `${balance} days`
              : '—'}
        </span>
      </p>

      <ConfirmModal
        open={pendingNeg != null}
        onClose={() => setPendingNeg(null)}
        onConfirm={() => {
          if (pendingNeg) return mut.mutateAsync(pendingNeg);
        }}
        title="Deduct leave days"
        impact={
          <>
            This removes{' '}
            <b>{Math.abs(Number(pendingNeg?.days ?? 0))}</b> day(s).
            {balance != null && (
              <>
                {' '}
                Projected balance:{' '}
                <b>{balance + Number(pendingNeg?.days ?? 0)}</b> days.
              </>
            )}
          </>
        }
        confirmLabel="Deduct"
        destructive
      />
    </Card>
  );
}

function PushCard({ worker }: { worker: WorkerDetail }) {
  const {
    register,
    handleSubmit,
    watch,
    reset,
    formState: { errors },
  } = useForm<PushForm>({ resolver: zodResolver(pushSchema) });

  const title = watch('title') ?? '';
  const body = watch('body') ?? '';

  const mut = useMutation({
    mutationFn: async (v: PushForm) => {
      const created = await growthApi.createPush({
        target_kind: 'specific',
        user_ids: [worker.id],
        title: String(v.title),
        body: String(v.body),
      });
      await growthApi.sendPush(created.id);
    },
    onSuccess: () => {
      showToast({ kind: 'success', message: 'Push sent' });
      reset();
    },
    onError: () =>
      showToast({
        kind: 'error',
        message: 'Campaign created but failed to send. Retry from Push page.',
      }),
  });

  return (
    <Card>
      <SectionTitle>Send Push Notification</SectionTitle>
      <form className="space-y-3" onSubmit={handleSubmit((v) => mut.mutate(v))}>
        <div>
          <div className="flex justify-between text-xs text-text-muted mb-1">
            <span>Title</span>
            <span>{String(title).length}/80</span>
          </div>
          <input
            className="input w-full"
            maxLength={80}
            {...register('title')}
          />
          {errors.title && (
            <p className="text-xs text-danger mt-1">
              {errors.title.message}
            </p>
          )}
        </div>
        <div>
          <div className="flex justify-between text-xs text-text-muted mb-1">
            <span>Body</span>
            <span>{String(body).length}/240</span>
          </div>
          <textarea
            className="input w-full min-h-[80px]"
            maxLength={240}
            {...register('body')}
          />
          {errors.body && (
            <p className="text-xs text-danger mt-1">{errors.body.message}</p>
          )}
        </div>
        <button
          className="btn-primary w-full inline-flex items-center justify-center gap-2"
          disabled={mut.isPending}
          type="submit"
        >
          <Bell className="w-4 h-4" />
          {mut.isPending ? 'Sending…' : 'Send to this worker'}
        </button>
      </form>
    </Card>
  );
}

// ──────────────────────────────────────────────────────────────────────────
// Tab 4 — Deductions
// ──────────────────────────────────────────────────────────────────────────

function DeductionsTab({ workerId }: { workerId: string }) {
  return (
    <Can
      perm="workers.deduct"
      fallback={
        <EmptyState
          icon={<BadgeCheck className="w-8 h-8" />}
          title="Not permitted"
          body="You need the workers.deduct permission to view deduction history."
        />
      }
    >
      <DeductionsTable workerId={workerId} />
    </Can>
  );
}

function DeductionsTable({ workerId }: { workerId: string }) {
  const q = useQuery({
    queryKey: workerKeys.deductions(workerId),
    queryFn: () => listDeductions(workerId),
  });

  if (q.isLoading) return <Skeleton className="h-40 w-full" />;

  const rows = q.data ?? [];
  if (rows.length === 0) {
    return (
      <EmptyState
        icon={<IndianRupee className="w-8 h-8" />}
        title="No deductions recorded for this pro"
      />
    );
  }

  return (
    <Card>
      <SectionTitle>Deduction History</SectionTitle>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="text-text-muted text-xs">
            <tr className="text-left">
              <th className="py-2 pr-3">Date</th>
              <th className="py-2 pr-3 text-right">Amount</th>
              <th className="py-2 pr-3">Reason</th>
              <th className="py-2 pr-3">Fortnight</th>
              <th className="py-2">Applied by</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((d) => (
              <tr
                key={d.id}
                className={`border-t border-border ${
                  d.reversed_at ? 'opacity-50' : ''
                }`}
              >
                <td className="py-2 pr-3 text-text-secondary">
                  {fmtDate(d.created_at)}
                </td>
                <td className="py-2 pr-3 text-right font-medium">
                  {formatRupeesExact(d.amount_paise)}
                </td>
                <td className="py-2 pr-3 break-words max-w-[180px]">
                  {d.reason}
                  {d.reversed_at && (
                    <span className="text-xs text-danger ml-1">
                      (reversed)
                    </span>
                  )}
                </td>
                <td className="py-2 pr-3 text-text-secondary">
                  {d.fortnight_start ? fmtDate(d.fortnight_start) : 'Current'}
                </td>
                <td className="py-2 font-mono text-xs text-text-muted">
                  {shortId(d.admin_id)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="text-xs text-text-muted mt-3">
        Showing up to 200 most recent. Server caps deduction history.
        Applied-by shows the admin UUID prefix — Phase 12 will join the email.
      </p>
    </Card>
  );
}

// ──────────────────────────────────────────────────────────────────────────
// Tab 5 — Payouts (payroll engine, not legacy manual crm_payouts)
// ──────────────────────────────────────────────────────────────────────────

const PAYOUT_STATUS_TONE: Record<PayoutStatus, 'success' | 'warning' | 'danger' | 'neutral'> = {
  pending_manual_payout: 'warning',
  paid: 'success',
  failed: 'danger',
  cancelled: 'neutral',
  skipped: 'neutral',
};

const PAYOUT_STATUS_LABEL: Record<PayoutStatus, string> = {
  pending_manual_payout: 'Pending',
  paid: 'Paid',
  failed: 'Failed',
  cancelled: 'Cancelled',
  skipped: 'Skipped',
};

function fmtCycle(start: string, end: string): string {
  // "2026-05-01" + "2026-05-15" → "May 1–15, 2026"
  // Cross-month not expected (cycles never straddle months) but
  // handle it just in case the cron ever lands one.
  const s = new Date(start + 'T00:00:00');
  const e = new Date(end + 'T00:00:00');
  if (Number.isNaN(s.getTime()) || Number.isNaN(e.getTime())) {
    return `${start} – ${end}`;
  }
  const sM = s.toLocaleString('en-IN', { month: 'short' });
  const eM = e.toLocaleString('en-IN', { month: 'short' });
  const year = e.getFullYear();
  if (sM === eM) return `${sM} ${s.getDate()}–${e.getDate()}, ${year}`;
  return `${sM} ${s.getDate()} – ${eM} ${e.getDate()}, ${year}`;
}

function fmtHours(minutes: number): string {
  return `${(minutes / 60).toFixed(1)}h`;
}

type ActionState =
  | { kind: 'none' }
  | { kind: 'mark_paid'; payout: Payout }
  | { kind: 'mark_failed'; payout: Payout }
  | { kind: 'recompute'; payout: Payout };

function PayoutsTab({
  workerId,
  workerName,
}: {
  workerId: string;
  workerName: string | null;
}) {
  const qc = useQueryClient();
  const [action, setAction] = useState<ActionState>({ kind: 'none' });
  const [notes, setNotes] = useState('');
  const [reason, setReason] = useState('');

  const q = useQuery({
    queryKey: payrollKeys.worker(workerId),
    queryFn: () => getWorkerPayouts(workerId),
  });

  const invalidate = () => qc.invalidateQueries({ queryKey: payrollKeys.worker(workerId) });

  const paidMut = useMutation({
    mutationFn: (p: Payout) => markPayoutPaid(p.id, { notes: notes.trim() || undefined }),
    onSuccess: () => {
      showToast({ kind: 'success', message: 'Payout marked paid.' });
      setAction({ kind: 'none' });
      setNotes('');
      invalidate();
    },
    onError: (err: unknown) => {
      const msg = err instanceof Error ? err.message : 'Failed to mark paid';
      showToast({ kind: 'error', message: msg });
    },
  });

  const failedMut = useMutation({
    mutationFn: (p: Payout) => markPayoutFailed(p.id, reason.trim()),
    onSuccess: () => {
      showToast({ kind: 'success', message: 'Payout marked failed.' });
      setAction({ kind: 'none' });
      setReason('');
      invalidate();
    },
    onError: (err: unknown) => {
      const msg = err instanceof Error ? err.message : 'Failed to mark failed';
      showToast({ kind: 'error', message: msg });
    },
  });

  const recomputeMut = useMutation({
    mutationFn: (p: Payout) => recomputePayout(p.id),
    onSuccess: () => {
      showToast({ kind: 'success', message: 'Payout recomputed.' });
      setAction({ kind: 'none' });
      invalidate();
    },
    onError: (err: unknown) => {
      const msg = err instanceof Error ? err.message : 'Recompute failed';
      showToast({ kind: 'error', message: msg });
    },
  });

  return (
    <Can
      perm="payouts.read"
      fallback={
        <EmptyState
          icon={<IndianRupee className="w-8 h-8" />}
          title="Not permitted"
          body="You need the payouts.read permission to view payroll history."
        />
      }
    >
      {q.isLoading && <Skeleton className="h-40 w-full" />}

      {q.data && (
        <>
          <div className="grid grid-cols-2 gap-3">
            <Card>
              <p className="text-xs text-text-muted">Lifetime paid</p>
              <p className="text-2xl font-semibold text-text-primary mt-1">
                {formatRupees(q.data.lifetime_paid_paise)}
              </p>
              <p className="text-xs text-text-muted mt-1">All cycles, status = paid.</p>
            </Card>
            <Card>
              <p className="text-xs text-text-muted">Current cycle</p>
              {q.data.current_cycle_pending ? (
                <>
                  <p className="text-2xl font-semibold text-warning mt-1">
                    {formatRupees(q.data.current_cycle_pending.net_pay_paise)}
                  </p>
                  <p className="text-xs text-text-muted mt-1">
                    Pending — {fmtCycle(q.data.current_cycle_pending.cycle_start, q.data.current_cycle_pending.cycle_end)}
                  </p>
                </>
              ) : (
                <>
                  <p className="text-sm text-text-secondary mt-2">No pending payout</p>
                  <p className="text-xs text-text-muted mt-1">Cron writes a row at 01:00 IST on cycle close.</p>
                </>
              )}
            </Card>
          </div>

          <Card>
            <SectionTitle>Recent payouts</SectionTitle>
            {q.data.recent_payouts.length === 0 ? (
              <EmptyState
                icon={<IndianRupee className="w-8 h-8" />}
                title="No payout rows yet"
                body="The payroll cron has not written a row for this pro. Cron fires at 01:00 IST on the 15th and last day of each month."
              />
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="text-text-muted text-xs">
                    <tr className="text-left">
                      <th className="py-2 pr-3">Cycle</th>
                      <th className="py-2 pr-3">Hours (online / working)</th>
                      <th className="py-2 pr-3 text-right">Net pay</th>
                      <th className="py-2 pr-3">Status</th>
                      <th className="py-2">Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {q.data.recent_payouts.map((p) => (
                      <tr key={p.id} className="border-t border-border">
                        <td className="py-2 pr-3 text-text-secondary">
                          {fmtCycle(p.cycle_start, p.cycle_end)}
                        </td>
                        <td className="py-2 pr-3 text-text-secondary">
                          {fmtHours(p.online_minutes)} / {fmtHours(p.working_minutes)}
                        </td>
                        <td className="py-2 pr-3 text-right font-medium">
                          {formatRupeesExact(p.net_pay_paise)}
                        </td>
                        <td className="py-2 pr-3">
                          <StatusPill tone={PAYOUT_STATUS_TONE[p.status]}>
                            {PAYOUT_STATUS_LABEL[p.status]}
                          </StatusPill>
                          {p.failure_reason && (
                            <p className="text-xs text-danger mt-1 max-w-[200px] break-words">
                              {p.failure_reason}
                            </p>
                          )}
                        </td>
                        <td className="py-2 space-x-2 whitespace-nowrap">
                          {p.status === 'pending_manual_payout' && (
                            <>
                              <Can perm="payouts.mark_paid">
                                <button
                                  className="btn-primary text-xs px-2 py-1"
                                  onClick={() => setAction({ kind: 'mark_paid', payout: p })}
                                >
                                  Mark paid
                                </button>
                              </Can>
                              <Can perm="payouts.recompute">
                                <button
                                  className="btn-ghost text-xs px-2 py-1"
                                  onClick={() => setAction({ kind: 'recompute', payout: p })}
                                >
                                  Recompute
                                </button>
                              </Can>
                              <Can perm="payouts.mark_failed">
                                <button
                                  className="btn-danger text-xs px-2 py-1"
                                  onClick={() => setAction({ kind: 'mark_failed', payout: p })}
                                >
                                  Mark failed
                                </button>
                              </Can>
                            </>
                          )}
                          {p.status === 'paid' && (
                            <Can perm="payouts.mark_failed">
                              <button
                                className="btn-danger text-xs px-2 py-1"
                                onClick={() => setAction({ kind: 'mark_failed', payout: p })}
                              >
                                Reverse (mark failed)
                              </button>
                            </Can>
                          )}
                          {p.status === 'failed' && (
                            <Can perm="payouts.recompute">
                              <button
                                className="btn-ghost text-xs px-2 py-1"
                                onClick={() => setAction({ kind: 'recompute', payout: p })}
                              >
                                Recompute
                              </button>
                            </Can>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            <p className="text-xs text-text-muted mt-3">
              Showing up to 12 most recent cycles. Audit log preserves full history.
            </p>
          </Card>
        </>
      )}

      {/* Mark paid modal — free-form notes, so not ConfirmModal. */}
      <Modal
        open={action.kind === 'mark_paid'}
        onClose={() => {
          setAction({ kind: 'none' });
          setNotes('');
        }}
        title="Mark payout as paid"
      >
        {action.kind === 'mark_paid' && (
          <>
            <p className="text-sm text-text-secondary mb-3">
              Mark <strong>{formatRupeesExact(action.payout.net_pay_paise)}</strong> as paid to{' '}
              <strong>{workerName ?? 'this worker'}</strong> for cycle{' '}
              {fmtCycle(action.payout.cycle_start, action.payout.cycle_end)}.
            </p>
            <p className="text-xs text-text-muted mb-3">
              paid_at defaults to now. Enter your bank transfer reference in notes.
            </p>
            <textarea
              className="input min-h-[80px] w-full"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="Notes (transaction ref, etc) — optional, max 500 chars"
              maxLength={500}
            />
            <div className="flex justify-end gap-2 mt-4">
              <button
                className="btn-ghost"
                onClick={() => {
                  setAction({ kind: 'none' });
                  setNotes('');
                }}
              >
                Cancel
              </button>
              <button
                className="btn-primary"
                disabled={paidMut.isPending}
                onClick={() => paidMut.mutate(action.payout)}
              >
                {paidMut.isPending ? 'Working…' : 'Mark paid'}
              </button>
            </div>
          </>
        )}
      </Modal>

      <Modal
        open={action.kind === 'mark_failed'}
        onClose={() => {
          setAction({ kind: 'none' });
          setReason('');
        }}
        title="Mark payout as failed"
      >
        {action.kind === 'mark_failed' && (
          <>
            <p className="text-sm text-text-secondary mb-3">
              This payout will move to <strong>failed</strong>. If it is currently{' '}
              <strong>paid</strong>, paid_at is preserved for audit. Reversible via Recompute.
            </p>
            <textarea
              className="input min-h-[90px] w-full"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="Reason (required, 1–500 chars)"
              maxLength={500}
            />
            <div className="flex justify-end gap-2 mt-4">
              <button
                className="btn-ghost"
                onClick={() => {
                  setAction({ kind: 'none' });
                  setReason('');
                }}
              >
                Cancel
              </button>
              <button
                className="btn-danger"
                disabled={reason.trim().length < 1 || failedMut.isPending}
                onClick={() => failedMut.mutate(action.payout)}
              >
                {failedMut.isPending ? 'Working…' : 'Mark failed'}
              </button>
            </div>
          </>
        )}
      </Modal>

      <ConfirmModal
        open={action.kind === 'recompute'}
        onClose={() => setAction({ kind: 'none' })}
        onConfirm={async () => {
          if (action.kind === 'recompute') {
            await recomputeMut.mutateAsync(action.payout);
          }
        }}
        title="Recompute payout"
        impact="Re-runs the calculation against current shift data and overwrites the hours and pay fields. If the row is currently failed, status moves back to pending and the failure reason is cleared so you can retry mark-paid. Audit log preserves the old values. Allowed only on pending or failed rows."
        confirmLabel="Recompute"
      />
    </Can>
  );
}

// ──────────────────────────────────────────────────────────────────────────
// Tab 6 — Targets & flags (proration + acceptance + open performance flags)
// ──────────────────────────────────────────────────────────────────────────

const FLAG_TYPE_LABEL: Record<HelperFlag['flag_type'], string> = {
  hours_target_missed: 'Hours target missed',
  acceptance_below_threshold: 'Acceptance below 85%',
};

function formatHours(h: number): string {
  return `${h.toFixed(1)}h`;
}

function formatPct(rate: number): string {
  return `${(rate * 100).toFixed(0)}%`;
}

type FlagAction =
  | { kind: 'none' }
  | { kind: 'reviewed'; flag: HelperFlag }
  | { kind: 'dismissed'; flag: HelperFlag }
  | { kind: 'escalated'; flag: HelperFlag };

function TargetsTab({ workerId }: { workerId: string }) {
  const qc = useQueryClient();
  const [action, setAction] = useState<FlagAction>({ kind: 'none' });
  const [notes, setNotes] = useState('');

  const q = useQuery({
    queryKey: performanceKeys.worker(workerId),
    queryFn: () => getWorkerPerformance(workerId),
  });

  const invalidate = () => qc.invalidateQueries({ queryKey: performanceKeys.worker(workerId) });

  const reviewMut = useMutation({
    mutationFn: ({ flag, kind }: { flag: HelperFlag; kind: FlagReviewAction }) =>
      reviewFlag(flag.id, kind, notes.trim() || undefined),
    onSuccess: () => {
      showToast({ kind: 'success', message: 'Flag updated.' });
      setAction({ kind: 'none' });
      setNotes('');
      invalidate();
    },
    onError: (err: unknown) => {
      const msg = err instanceof Error ? err.message : 'Flag update failed';
      showToast({ kind: 'error', message: msg });
    },
  });

  return (
    <Can
      perm="payouts.read"
      fallback={
        <EmptyState
          icon={<BadgeCheck className="w-8 h-8" />}
          title="Not permitted"
          body="You need the payouts.read permission to view performance."
        />
      }
    >
      {q.isLoading && <Skeleton className="h-40 w-full" />}

      {q.data && (
        <>
          <Card>
            <SectionTitle>This cycle</SectionTitle>
            <p className="text-xs text-text-muted mb-3">
              {q.data.cycle_start} → {q.data.cycle_end} ({q.data.days_available} days available)
            </p>

            <div className="grid grid-cols-2 gap-3">
              <div className="card p-3">
                <p className="text-xs text-text-muted">Hours target (prorated)</p>
                <p className="text-2xl font-semibold mt-1">
                  {q.data.hours_status === 'na' ? '—' : `${q.data.target_hours}h`}
                </p>
                <p className="text-xs text-text-muted mt-1">
                  Logged {formatHours(q.data.online_hours)} ({formatHours(q.data.working_hours)} working)
                </p>
                <div className="mt-2">
                  {q.data.hours_status === 'on_track' && (
                    <StatusPill tone="success">On track</StatusPill>
                  )}
                  {q.data.hours_status === 'behind' && (
                    <StatusPill tone="warning">Behind target</StatusPill>
                  )}
                  {q.data.hours_status === 'na' && (
                    <StatusPill tone="neutral">N/A (not eligible)</StatusPill>
                  )}
                </div>
              </div>

              <div className="card p-3">
                <p className="text-xs text-text-muted">Acceptance rate</p>
                <p className="text-2xl font-semibold mt-1">
                  {q.data.acceptance_rate == null ? '—' : formatPct(q.data.acceptance_rate)}
                </p>
                <p className="text-xs text-text-muted mt-1">
                  {q.data.acceptance_accepted} accepted / {q.data.acceptance_dispatched} dispatched
                </p>
                <div className="mt-2">
                  {q.data.acceptance_status === 'ok' && (
                    <StatusPill tone="success">≥ 85%</StatusPill>
                  )}
                  {q.data.acceptance_status === 'below_threshold' && (
                    <StatusPill tone="warning">Below 85%</StatusPill>
                  )}
                  {q.data.acceptance_status === 'na' && (
                    <StatusPill tone="neutral">N/A (no offers)</StatusPill>
                  )}
                </div>
              </div>
            </div>
          </Card>

          <Card>
            <SectionTitle>Open flags for this cycle</SectionTitle>
            {q.data.open_flags.length === 0 ? (
              <EmptyState
                icon={<CheckCircle2 className="w-8 h-8" />}
                title="No open flags"
                body="Flags are written by the payroll cron at cycle close. Nothing to action right now."
              />
            ) : (
              <div className="space-y-2">
                {q.data.open_flags.map((f) => (
                  <div key={f.id} className="border border-border rounded-md p-3">
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <p className="font-medium text-sm">{FLAG_TYPE_LABEL[f.flag_type]}</p>
                        <p className="text-xs text-text-muted mt-1">
                          {f.cycle_start} → {f.cycle_end} · raised {fmtRel(f.created_at)}
                        </p>
                        <p className="text-xs text-text-secondary mt-2">
                          {f.flag_type === 'hours_target_missed'
                            ? `Actual ${f.actual_value.toFixed(1)}h vs target ${Math.round(f.expected_value)}h`
                            : `Actual ${formatPct(f.actual_value)} vs required ${formatPct(f.expected_value)}`}
                        </p>
                      </div>
                      <StatusPill tone="warning">Open</StatusPill>
                    </div>
                    <Can perm="flags.review">
                      <div className="flex gap-2 mt-3">
                        <button
                          className="btn-ghost text-xs px-2 py-1"
                          onClick={() => setAction({ kind: 'reviewed', flag: f })}
                        >
                          Mark reviewed
                        </button>
                        <button
                          className="btn-ghost text-xs px-2 py-1"
                          onClick={() => setAction({ kind: 'dismissed', flag: f })}
                        >
                          Dismiss
                        </button>
                        <button
                          className="btn-danger text-xs px-2 py-1"
                          onClick={() => setAction({ kind: 'escalated', flag: f })}
                        >
                          Escalate
                        </button>
                      </div>
                    </Can>
                  </div>
                ))}
              </div>
            )}
            <p className="text-xs text-text-muted mt-3">
              Flags are admin-review only. They never auto-deactivate a pro.
            </p>
          </Card>
        </>
      )}

      <Modal
        open={action.kind !== 'none'}
        onClose={() => {
          setAction({ kind: 'none' });
          setNotes('');
        }}
        title={
          action.kind === 'escalated'
            ? 'Escalate flag'
            : action.kind === 'dismissed'
              ? 'Dismiss flag'
              : 'Mark flag reviewed'
        }
      >
        {action.kind !== 'none' && (
          <>
            <p className="text-sm text-text-secondary mb-3">
              {FLAG_TYPE_LABEL[action.flag.flag_type]} —{' '}
              {action.flag.cycle_start} → {action.flag.cycle_end}
            </p>
            <textarea
              className="input min-h-[80px] w-full"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="Notes (optional, max 500 chars)"
              maxLength={500}
            />
            <div className="flex justify-end gap-2 mt-4">
              <button
                className="btn-ghost"
                onClick={() => {
                  setAction({ kind: 'none' });
                  setNotes('');
                }}
              >
                Cancel
              </button>
              <button
                className={action.kind === 'escalated' ? 'btn-danger' : 'btn-primary'}
                disabled={reviewMut.isPending}
                onClick={() =>
                  reviewMut.mutate({ flag: action.flag, kind: action.kind })
                }
              >
                {reviewMut.isPending ? 'Working…' : 'Confirm'}
              </button>
            </div>
          </>
        )}
      </Modal>
    </Can>
  );
}
