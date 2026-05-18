import { useEffect, useMemo, useState } from 'react';
import { useForm, type SubmitHandler, type UseFormReturn } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useBlocker, useNavigate } from 'react-router-dom';
import {
  ArrowLeft, Check, ChevronRight, Edit2, Loader2, AlertTriangle,
} from 'lucide-react';

import {
  createWorker, PhoneInUseError, workerKeys,
  type CreateWorkerRequest,
} from '@/api/workers';
import { listLocalities, type Locality } from '@/api/localities';
import { zonesApi, type Zone } from '@/api/all';
import { Card } from '@/components/ui';
import { showToast } from '@/components/ui/Toast';

// ── Static option sets ──────────────────────────────────────────────────
// Languages: ISO-639 codes for the storage value, English label for display.
const LANGUAGE_OPTIONS: { value: string; label: string }[] = [
  { value: 'hi', label: 'Hindi' },
  { value: 'en', label: 'English' },
  { value: 'bn', label: 'Bengali' },
  { value: 'ta', label: 'Tamil' },
  { value: 'te', label: 'Telugu' },
  { value: 'mr', label: 'Marathi' },
  { value: 'gu', label: 'Gujarati' },
  { value: 'pa', label: 'Punjabi' },
  { value: 'other', label: 'Other' },
];

// Service category slugs. Hardcoded for now — backend uses freeform strings
// and there's no GET /admin/service-categories endpoint exposed on crm-api
// yet. Wire to dynamic source when backend exposes a list endpoint.
const CATEGORY_OPTIONS: { value: string; label: string }[] = [
  { value: 'utensils',     label: 'Utensils' },
  { value: 'sweep_mop',    label: 'Sweep & Mop' },
  { value: 'dusting',      label: 'Dusting' },
  { value: 'bathroom',     label: 'Bathroom' },
  { value: 'kitchen_prep', label: 'Kitchen Prep' },
  { value: 'laundry',      label: 'Laundry' },
  { value: 'ironing',      label: 'Ironing' },
  { value: 'balcony',      label: 'Balcony' },
];
const CATEGORY_VALUES = CATEGORY_OPTIONS.map((c) => c.value) as [string, ...string[]];

// ── Validation ──────────────────────────────────────────────────────────
// Per-step schemas drive the gating logic for the Next button. The master
// schema is the union — Submit re-validates everything to catch any cross-
// step drift before posting.

const PHONE_10 = /^[6-9]\d{9}$/;
const stripPlus91 = (s: string) => s.replace(/^\+?91/, '').replace(/\D/g, '');

const DOB_FMT = /^\d{4}-\d{2}-\d{2}$/;

const personalSchema = z.object({
  name: z.string().trim().min(2, 'min 2 characters').max(200, 'max 200 characters'),
  dob: z
    .string()
    .trim()
    .optional()
    .refine((v) => !v || DOB_FMT.test(v), 'expected YYYY-MM-DD')
    .refine((v) => {
      if (!v) return true;
      const t = Date.parse(v);
      if (Number.isNaN(t)) return false;
      const age = (Date.now() - t) / (365.25 * 24 * 3600 * 1000);
      return age >= 18 && age <= 80;
    }, 'age must be between 18 and 80'),
  gender: z.enum(['male', 'female', 'other']).optional(),
  languages: z.array(z.string()).max(10, 'pick at most 10 languages').optional(),
});

const contactSchema = z.object({
  phone: z
    .string()
    .trim()
    .transform(stripPlus91)
    .refine((v) => PHONE_10.test(v), 'must be a 10-digit Indian mobile starting 6-9'),
  alt_phone: z
    .string()
    .trim()
    .optional()
    .transform((v) => (v ? stripPlus91(v) : ''))
    .refine((v) => !v || PHONE_10.test(v), 'must be a 10-digit Indian mobile if provided'),
  email: z.string().trim().email('invalid email').or(z.literal('')).optional(),
  address: z.string().trim().max(2000, 'max 2000 characters').optional(),
  emergency_contact_name: z.string().trim().max(200, 'max 200 characters').optional(),
  emergency_contact_phone: z
    .string()
    .trim()
    .optional()
    .transform((v) => (v ? stripPlus91(v) : ''))
    .refine((v) => !v || PHONE_10.test(v), 'must be a 10-digit Indian mobile if provided'),
}).refine(
  (v) => !v.alt_phone || v.alt_phone !== v.phone,
  { message: 'alt phone must differ from primary', path: ['alt_phone'] },
);

const workSchema = z.object({
  locality: z.string().trim().min(1, 'required'),
  zone_id: z.string().trim().optional(),
  categories: z
    .array(z.enum(CATEGORY_VALUES))
    .min(1, 'select at least one service category'),
  weekly_hours_target: z
    .number()
    .int('integer only')
    .min(40, 'min 40 hours/week')
    .max(168, 'max 168 hours/week')
    .optional(),
  start_active: z.boolean().optional(),
});

const IFSC = /^[A-Z]{4}0[A-Z0-9]{6}$/;
const kycSchema = z.object({
  aadhaar_number: z
    .string()
    .trim()
    .optional()
    .transform((v) => (v ? v.replace(/\s+/g, '') : ''))
    .refine((v) => !v || /^\d{12}$/.test(v), 'must be 12 digits'),
  bank_account_holder_name: z
    .string()
    .trim()
    .optional()
    .refine((v) => !v || v.length >= 2, 'min 2 characters'),
  bank_account_number: z
    .string()
    .trim()
    .optional()
    .refine((v) => !v || /^\d{9,18}$/.test(v), 'must be 9-18 digits'),
  bank_ifsc: z
    .string()
    .trim()
    .optional()
    .transform((v) => (v ? v.toUpperCase() : ''))
    .refine((v) => !v || IFSC.test(v), 'invalid IFSC (ABCD0EFGHIJ)'),
  photo_url: z
    .string()
    .trim()
    .optional()
    .refine((v) => {
      if (!v) return true;
      try { new URL(v); return true; } catch { return false; }
    }, 'must be a valid URL'),
});

const fullSchema = personalSchema.and(contactSchema).and(workSchema).and(kycSchema);

// FormValues is decoupled from `z.infer<typeof fullSchema>` on purpose: the
// schema uses `.transform()` on optional phone fields, which turns the OUTPUT
// type into `string` (the transformed empty-string default) and breaks the
// generic inference react-hook-form does over the resolver. The runtime shape
// is exactly what we hand-roll here.
type FormValues = {
  name: string;
  dob?: string;
  gender?: 'male' | 'female' | 'other';
  languages?: string[];
  phone: string;
  alt_phone?: string;
  email?: string;
  address?: string;
  emergency_contact_name?: string;
  emergency_contact_phone?: string;
  locality: string;
  zone_id?: string;
  categories: string[];
  weekly_hours_target?: number;
  start_active?: boolean;
  aadhaar_number?: string;
  bank_account_holder_name?: string;
  bank_account_number?: string;
  bank_ifsc?: string;
  photo_url?: string;
};

// Names of fields validated per step — used to scope react-hook-form's
// trigger() call so "Next" only blocks on the current step's errors.
const STEP_FIELDS: Array<(keyof FormValues)[]> = [
  ['name', 'dob', 'gender', 'languages'],
  ['phone', 'alt_phone', 'email', 'address', 'emergency_contact_name', 'emergency_contact_phone'],
  ['locality', 'zone_id', 'categories', 'weekly_hours_target', 'start_active'],
  ['aadhaar_number', 'bank_account_holder_name', 'bank_account_number', 'bank_ifsc', 'photo_url'],
  [],
];

const STEP_LABELS = ['Personal', 'Contact', 'Work', 'KYC', 'Review'];

// ── Helpers ─────────────────────────────────────────────────────────────

// Drop empty strings + empty arrays before posting so the backend gets
// proper `IS NULL` semantics rather than empty-string columns. The backend
// is defensive (it TrimSpaces) but the principle is: the client lies about
// nothing.
function buildPayload(v: FormValues): CreateWorkerRequest {
  const out: CreateWorkerRequest = {
    name: v.name.trim(),
    phone: v.phone, // already stripped to 10 digits by zod transform
  };
  if (v.dob) out.dob = v.dob;
  if (v.gender) out.gender = v.gender;
  if (v.languages && v.languages.length) out.languages = v.languages;
  if (v.alt_phone) out.alt_phone = v.alt_phone;
  if (v.email && v.email.length) out.email = v.email;
  if (v.address && v.address.length) out.address = v.address.trim();
  if (v.emergency_contact_name) out.emergency_contact_name = v.emergency_contact_name.trim();
  if (v.emergency_contact_phone) out.emergency_contact_phone = v.emergency_contact_phone;
  if (v.locality) out.locality = v.locality;
  if (v.zone_id) out.zone_id = v.zone_id;
  if (v.categories && v.categories.length) out.categories = v.categories;
  if (typeof v.weekly_hours_target === 'number') out.weekly_hours_target = v.weekly_hours_target;
  if (v.start_active) out.start_active = true;
  if (v.aadhaar_number) out.aadhaar_number = v.aadhaar_number;
  if (v.bank_account_holder_name) out.bank_account_holder_name = v.bank_account_holder_name.trim();
  if (v.bank_account_number) out.bank_account_number = v.bank_account_number;
  if (v.bank_ifsc) out.bank_ifsc = v.bank_ifsc;
  if (v.photo_url) out.photo_url = v.photo_url;
  return out;
}

// ── Component ───────────────────────────────────────────────────────────

export function WorkerNewPage() {
  const nav = useNavigate();
  const qc = useQueryClient();
  const [step, setStep] = useState(0);

  const form = useForm<FormValues>({
    resolver: zodResolver(fullSchema),
    mode: 'onChange',
    defaultValues: {
      name: '',
      dob: '',
      gender: undefined,
      languages: [],
      phone: '',
      alt_phone: '',
      email: '',
      address: '',
      emergency_contact_name: '',
      emergency_contact_phone: '',
      locality: '',
      zone_id: '',
      categories: [],
      weekly_hours_target: 80,
      start_active: false,
      aadhaar_number: '',
      bank_account_holder_name: '',
      bank_account_number: '',
      bank_ifsc: '',
      photo_url: '',
    },
  });

  const isDirty = form.formState.isDirty;

  // Browser back / refresh guard. useBlocker handles react-router navigation
  // (e.g. back arrow → /workers); beforeunload covers the hard-reload case.
  const blocker = useBlocker(isDirty && !form.formState.isSubmitting);
  useEffect(() => {
    if (!isDirty) return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [isDirty]);

  const submit = useMutation({
    mutationFn: (payload: CreateWorkerRequest) => createWorker(payload),
    onSuccess: (result, _vars) => {
      void qc.invalidateQueries({ queryKey: workerKeys.all });
      showToast({
        kind: 'success',
        message: `Pro created. They can now log in with phone +91${form.getValues('phone')} + OTP.`,
      });
      // form.reset clears dirty so useBlocker stops blocking.
      form.reset(undefined, { keepValues: true });
      nav(`/workers/${result.id}`, { replace: true });
    },
    onError: (err: unknown) => {
      if (err instanceof PhoneInUseError) {
        setStep(1);
        form.setError('phone', {
          type: 'manual',
          message: 'this phone is already registered',
        });
        // Defer focus until the step swap completes.
        setTimeout(() => form.setFocus('phone'), 0);
        showToast({ kind: 'error', message: 'phone already registered. Edit and retry.' });
        return;
      }
      // Other errors get the generic toast from the axios interceptor.
    },
  });

  const goNext = async () => {
    const fields = STEP_FIELDS[step];
    const ok = fields.length === 0 ? true : await form.trigger(fields as never);
    if (!ok) return;
    setStep((s) => Math.min(s + 1, STEP_LABELS.length - 1));
  };

  const goBack = () => setStep((s) => Math.max(s - 1, 0));

  const onSubmit: SubmitHandler<FormValues> = (v) => {
    submit.mutate(buildPayload(v));
  };

  return (
    <div className="p-6 max-w-3xl mx-auto space-y-6">
      <UnsavedChangesGuard
        proceed={() => blocker.proceed?.()}
        reset={() => blocker.reset?.()}
        active={blocker.state === 'blocked'}
      />

      <div className="flex items-center gap-3">
        <Link to="/workers" className="btn-ghost !p-2" aria-label="back to workers">
          <ArrowLeft className="w-4 h-4" />
        </Link>
        <div className="flex-1">
          <h1 className="text-2xl font-semibold tracking-tight">New Pro</h1>
          <p className="text-sm text-text-secondary mt-1">
            Admin-driven registration. Pro can log in with phone + OTP after creation.
          </p>
        </div>
      </div>

      <StepIndicator current={step} onClickStep={(i) => i < step && setStep(i)} />

      <form onSubmit={form.handleSubmit(onSubmit)}>
        <Card>
          {step === 0 && <StepPersonal form={form} />}
          {step === 1 && <StepContact form={form} />}
          {step === 2 && <StepWork form={form} />}
          {step === 3 && <StepKYC form={form} />}
          {step === 4 && <StepReview values={form.watch()} onEdit={setStep} />}

          <div className="mt-6 pt-5 border-t border-border flex items-center justify-between">
            <button
              type="button"
              className="btn-ghost"
              onClick={goBack}
              disabled={step === 0}
            >
              Back
            </button>
            {step < STEP_LABELS.length - 1 ? (
              <button
                type="button"
                className="btn-primary"
                onClick={goNext}
              >
                Next
                <ChevronRight className="w-4 h-4" />
              </button>
            ) : (
              <button
                type="submit"
                className="btn-primary"
                disabled={submit.isPending}
              >
                {submit.isPending ? (
                  <>
                    <Loader2 className="w-4 h-4 animate-spin" />
                    Creating…
                  </>
                ) : (
                  <>
                    <Check className="w-4 h-4" />
                    Submit
                  </>
                )}
              </button>
            )}
          </div>
        </Card>
      </form>
    </div>
  );
}

// ── Step indicator ──────────────────────────────────────────────────────

function StepIndicator({
  current, onClickStep,
}: { current: number; onClickStep: (i: number) => void }) {
  return (
    <div className="flex items-center gap-2 overflow-x-auto pb-1">
      {STEP_LABELS.map((label, i) => {
        const state: 'done' | 'active' | 'future' =
          i < current ? 'done' : i === current ? 'active' : 'future';
        const cls =
          state === 'active'
            ? 'border-primary/40 text-text-primary bg-primary/10'
            : state === 'done'
            ? 'border-success/40 text-success bg-success/10 cursor-pointer hover:brightness-110'
            : 'border-border text-text-muted bg-surface-elevated';
        return (
          <button
            key={label}
            type="button"
            onClick={() => onClickStep(i)}
            disabled={state !== 'done'}
            className={`pill !px-3 !py-1.5 !text-xs ${cls}`}
          >
            <span className="font-mono">{i + 1}.</span>
            <span>{label}</span>
            {state === 'done' && <Check className="w-3 h-3" />}
          </button>
        );
      })}
    </div>
  );
}

// ── Step components ─────────────────────────────────────────────────────

type StepProps = { form: UseFormReturn<FormValues> };

function FieldLabel({
  children, required, hint,
}: { children: React.ReactNode; required?: boolean; hint?: string }) {
  return (
    <label className="block text-xs uppercase tracking-wider text-text-muted mb-2">
      {children}
      {required && <span className="text-danger ml-1">*</span>}
      {hint && <span className="ml-2 normal-case tracking-normal text-text-muted/70">{hint}</span>}
    </label>
  );
}

function ErrText({ msg }: { msg?: string }) {
  if (!msg) return null;
  return <p className="mt-1.5 text-xs text-danger">{msg}</p>;
}

function StepPersonal({ form }: StepProps) {
  const { register, watch, setValue, formState: { errors } } = form;
  const languages = watch('languages') ?? [];
  const gender = watch('gender');

  const toggleLanguage = (v: string) => {
    const next = languages.includes(v)
      ? languages.filter((l) => l !== v)
      : [...languages, v];
    setValue('languages', next, { shouldDirty: true });
  };

  return (
    <div className="space-y-5">
      <h2 className="text-lg font-semibold">Personal</h2>

      <div>
        <FieldLabel required>Full name</FieldLabel>
        <input className="input" {...register('name')} autoFocus />
        <ErrText msg={errors.name?.message as string | undefined} />
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div>
          <FieldLabel hint="YYYY-MM-DD">Date of birth</FieldLabel>
          <input className="input" type="date" {...register('dob')} />
          <ErrText msg={errors.dob?.message as string | undefined} />
        </div>
        <div>
          <FieldLabel>Gender</FieldLabel>
          <div className="flex gap-2">
            {(['male', 'female', 'other'] as const).map((g) => (
              <button
                type="button"
                key={g}
                className={`pill !px-3 !py-2 !text-sm capitalize ${
                  gender === g
                    ? 'border-primary/40 bg-primary/10 text-text-primary'
                    : 'border-border bg-surface-elevated text-text-secondary hover:text-text-primary'
                }`}
                onClick={() => setValue('gender', gender === g ? undefined : g, { shouldDirty: true })}
              >
                {g}
              </button>
            ))}
          </div>
        </div>
      </div>

      <div>
        <FieldLabel>Languages spoken</FieldLabel>
        <div className="flex flex-wrap gap-2">
          {LANGUAGE_OPTIONS.map((l) => {
            const on = languages.includes(l.value);
            return (
              <button
                type="button"
                key={l.value}
                onClick={() => toggleLanguage(l.value)}
                className={`pill !px-3 !py-1.5 ${
                  on
                    ? 'border-primary/40 bg-primary/10 text-text-primary'
                    : 'border-border bg-surface-elevated text-text-secondary hover:text-text-primary'
                }`}
              >
                {l.label}
              </button>
            );
          })}
        </div>
        <ErrText msg={errors.languages?.message as string | undefined} />
      </div>
    </div>
  );
}

function StepContact({ form }: StepProps) {
  const { register, formState: { errors } } = form;
  return (
    <div className="space-y-5">
      <h2 className="text-lg font-semibold">Contact</h2>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div>
          <FieldLabel required hint="10 digits">Phone</FieldLabel>
          <div className="relative">
            <span className="absolute left-3 top-1/2 -translate-y-1/2 text-text-muted text-sm font-mono">+91</span>
            <input
              className="input pl-12 font-mono"
              inputMode="numeric"
              maxLength={13}
              {...register('phone')}
            />
          </div>
          <ErrText msg={errors.phone?.message as string | undefined} />
        </div>
        <div>
          <FieldLabel>Alt phone</FieldLabel>
          <div className="relative">
            <span className="absolute left-3 top-1/2 -translate-y-1/2 text-text-muted text-sm font-mono">+91</span>
            <input
              className="input pl-12 font-mono"
              inputMode="numeric"
              maxLength={13}
              {...register('alt_phone')}
            />
          </div>
          <ErrText msg={errors.alt_phone?.message as string | undefined} />
        </div>
      </div>

      <div>
        <FieldLabel>Email</FieldLabel>
        <input className="input" type="email" {...register('email')} />
        <ErrText msg={errors.email?.message as string | undefined} />
      </div>

      <div>
        <FieldLabel>Address</FieldLabel>
        <textarea className="input" rows={3} {...register('address')} />
        <ErrText msg={errors.address?.message as string | undefined} />
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div>
          <FieldLabel>
            Emergency contact name
            <span className="ml-2 normal-case tracking-normal text-warning/80">recommended</span>
          </FieldLabel>
          <input className="input" {...register('emergency_contact_name')} />
          <ErrText msg={errors.emergency_contact_name?.message as string | undefined} />
        </div>
        <div>
          <FieldLabel>
            Emergency contact phone
            <span className="ml-2 normal-case tracking-normal text-warning/80">recommended</span>
          </FieldLabel>
          <div className="relative">
            <span className="absolute left-3 top-1/2 -translate-y-1/2 text-text-muted text-sm font-mono">+91</span>
            <input
              className="input pl-12 font-mono"
              inputMode="numeric"
              maxLength={13}
              {...register('emergency_contact_phone')}
            />
          </div>
          <ErrText msg={errors.emergency_contact_phone?.message as string | undefined} />
        </div>
      </div>
    </div>
  );
}

function StepWork({ form }: StepProps) {
  const { register, watch, setValue, formState: { errors } } = form;
  const categories = watch('categories') ?? [];
  const startActive = watch('start_active');

  const localitiesQ = useQuery<Locality[]>({
    queryKey: ['localities', 'active'],
    queryFn: () => listLocalities({ activeOnly: true }),
    staleTime: 5 * 60_000,
  });

  const zonesQ = useQuery<Zone[]>({
    queryKey: ['zones', 'all'],
    queryFn: () => zonesApi.list(),
    staleTime: 5 * 60_000,
  });

  const toggleCategory = (v: string) => {
    const next = categories.includes(v)
      ? categories.filter((c) => c !== v)
      : [...categories, v];
    setValue('categories', next as FormValues['categories'], {
      shouldDirty: true,
      shouldValidate: true,
    });
  };

  return (
    <div className="space-y-5">
      <h2 className="text-lg font-semibold">Work</h2>

      <div>
        <FieldLabel required>Locality (operational area)</FieldLabel>
        <select className="input" {...register('locality')}>
          <option value="">— Select —</option>
          {localitiesQ.isLoading && <option disabled>Loading…</option>}
          {(localitiesQ.data ?? []).map((l) => (
            <option key={l.id} value={l.name}>
              {l.name} · {l.city}
            </option>
          ))}
        </select>
        <ErrText msg={errors.locality?.message as string | undefined} />
      </div>

      <div>
        <FieldLabel hint="optional — assign later from worker detail">Zone</FieldLabel>
        <select className="input" {...register('zone_id')}>
          <option value="">— None —</option>
          {zonesQ.isLoading && <option disabled>Loading…</option>}
          {(zonesQ.data ?? []).filter((z) => z.is_active).map((z) => (
            <option key={z.id} value={z.id}>
              {z.name} · {z.city}
            </option>
          ))}
        </select>
      </div>

      <div>
        <FieldLabel required>Service categories</FieldLabel>
        <div className="flex flex-wrap gap-2">
          {CATEGORY_OPTIONS.map((c) => {
            const on = categories.includes(c.value);
            return (
              <button
                type="button"
                key={c.value}
                onClick={() => toggleCategory(c.value)}
                className={`pill !px-3 !py-1.5 ${
                  on
                    ? 'border-primary/40 bg-primary/10 text-text-primary'
                    : 'border-border bg-surface-elevated text-text-secondary hover:text-text-primary'
                }`}
              >
                {c.label}
              </button>
            );
          })}
        </div>
        <ErrText msg={errors.categories?.message as string | undefined} />
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div>
          <FieldLabel hint="40–168, default 80">Weekly hours target</FieldLabel>
          <input
            className="input"
            type="number"
            min={40}
            max={168}
            {...register('weekly_hours_target', { valueAsNumber: true })}
          />
          <ErrText msg={errors.weekly_hours_target?.message as string | undefined} />
        </div>
        <div className="flex flex-col">
          <FieldLabel>Activation</FieldLabel>
          <label className="card-elevated p-4 flex items-start gap-3 cursor-pointer">
            <input
              type="checkbox"
              className="mt-1"
              {...register('start_active')}
            />
            <div>
              <div className="text-sm">Activate immediately (skip in_training)</div>
              <div className="text-xs text-text-secondary mt-1">
                {startActive
                  ? 'Pro can take bookings right away.'
                  : 'Unchecked = pro goes to in_training status, requires explicit approval before they can take bookings.'}
              </div>
            </div>
          </label>
        </div>
      </div>
    </div>
  );
}

function StepKYC({ form }: StepProps) {
  const { register, formState: { errors } } = form;
  return (
    <div className="space-y-5">
      <h2 className="text-lg font-semibold">KYC</h2>

      <div className="card-elevated p-3 flex items-start gap-3 border-warning/30">
        <AlertTriangle className="w-4 h-4 text-warning shrink-0 mt-0.5" />
        <p className="text-xs text-text-secondary">
          KYC information is stored unencrypted in this phase. Phase 12 will add
          encryption-at-rest and role-based masking. Do not share or screenshot.
        </p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div>
          <FieldLabel hint="12 digits, manual verify for now">Aadhaar number</FieldLabel>
          <input
            className="input font-mono"
            inputMode="numeric"
            maxLength={14}
            placeholder="XXXX XXXX XXXX"
            {...register('aadhaar_number')}
          />
          <ErrText msg={errors.aadhaar_number?.message as string | undefined} />
        </div>
        <div>
          <FieldLabel hint="must match name on account exactly">Bank account holder name</FieldLabel>
          <input className="input" {...register('bank_account_holder_name')} />
          <ErrText msg={errors.bank_account_holder_name?.message as string | undefined} />
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div>
          <FieldLabel hint="9–18 digits">Bank account number</FieldLabel>
          <input
            className="input font-mono"
            inputMode="numeric"
            {...register('bank_account_number')}
          />
          <ErrText msg={errors.bank_account_number?.message as string | undefined} />
        </div>
        <div>
          <FieldLabel hint="e.g. HDFC0001234">IFSC</FieldLabel>
          <input
            className="input font-mono uppercase"
            maxLength={11}
            {...register('bank_ifsc')}
          />
          <ErrText msg={errors.bank_ifsc?.message as string | undefined} />
        </div>
      </div>

      <div>
        <FieldLabel hint="upload to S3/Cloudinary separately and paste URL — upload UI is Phase 12">
          Photo URL
        </FieldLabel>
        <input className="input" type="url" {...register('photo_url')} />
        <ErrText msg={errors.photo_url?.message as string | undefined} />
      </div>
    </div>
  );
}

function StepReview({
  values, onEdit,
}: { values: FormValues; onEdit: (i: number) => void }) {
  const langs = useMemo(() => (values.languages ?? []).map((v) =>
    LANGUAGE_OPTIONS.find((o) => o.value === v)?.label ?? v,
  ), [values.languages]);
  const cats = useMemo(() => (values.categories ?? []).map((v) =>
    CATEGORY_OPTIONS.find((o) => o.value === v)?.label ?? v,
  ), [values.categories]);

  return (
    <div className="space-y-5">
      <h2 className="text-lg font-semibold">Review</h2>
      <p className="text-sm text-text-secondary">
        Double-check before submit. Click <span className="text-text-primary">Edit</span> on any
        section to jump back.
      </p>

      <ReviewSection title="Personal" onEdit={() => onEdit(0)}>
        <KV k="Name" v={values.name} />
        <KV k="DOB" v={values.dob || '—'} />
        <KV k="Gender" v={values.gender ?? '—'} />
        <KV k="Languages" v={langs.length ? langs.join(', ') : '—'} />
      </ReviewSection>

      <ReviewSection title="Contact" onEdit={() => onEdit(1)}>
        <KV k="Phone" v={values.phone ? `+91 ${values.phone}` : '—'} />
        <KV k="Alt phone" v={values.alt_phone ? `+91 ${values.alt_phone}` : '—'} />
        <KV k="Email" v={values.email || '—'} />
        <KV k="Address" v={values.address || '—'} />
        <KV k="Emergency name" v={values.emergency_contact_name || '—'} />
        <KV k="Emergency phone" v={values.emergency_contact_phone ? `+91 ${values.emergency_contact_phone}` : '—'} />
      </ReviewSection>

      <ReviewSection title="Work" onEdit={() => onEdit(2)}>
        <KV k="Locality" v={values.locality || '—'} />
        <KV k="Zone" v={values.zone_id || '—'} />
        <KV k="Categories" v={cats.length ? cats.join(', ') : '—'} />
        <KV k="Weekly hours target" v={String(values.weekly_hours_target ?? 80)} />
        <KV k="Start active" v={values.start_active ? 'Yes' : 'No (goes to in_training)'} />
      </ReviewSection>

      <ReviewSection title="KYC" onEdit={() => onEdit(3)}>
        <KV
          k="Aadhaar"
          v={values.aadhaar_number ? maskAadhaar(values.aadhaar_number) : '—'}
        />
        <KV k="Bank holder" v={values.bank_account_holder_name || '—'} />
        <KV
          k="Bank account"
          v={values.bank_account_number ? maskAccount(values.bank_account_number) : '—'}
        />
        <KV k="IFSC" v={values.bank_ifsc || '—'} />
        <KV k="Photo URL" v={values.photo_url || '—'} />
      </ReviewSection>
    </div>
  );
}

function ReviewSection({
  title, onEdit, children,
}: { title: string; onEdit: () => void; children: React.ReactNode }) {
  return (
    <div className="card-elevated p-4">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-sm font-semibold">{title}</h3>
        <button type="button" className="btn-ghost !py-1 !px-2 text-xs" onClick={onEdit}>
          <Edit2 className="w-3 h-3" /> Edit
        </button>
      </div>
      <div className="space-y-1.5">{children}</div>
    </div>
  );
}

function KV({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex items-baseline gap-3 text-sm">
      <span className="text-text-muted min-w-[160px]">{k}</span>
      <span className="text-text-primary break-all">{v}</span>
    </div>
  );
}

// Soft-mask helpers — display-only, don't change the form values.
function maskAadhaar(s: string) {
  const digits = s.replace(/\s+/g, '');
  if (digits.length < 12) return s;
  return `XXXX XXXX ${digits.slice(-4)}`;
}
function maskAccount(s: string) {
  if (s.length <= 4) return s;
  return `${'X'.repeat(s.length - 4)}${s.slice(-4)}`;
}

// ── Unsaved-changes modal ───────────────────────────────────────────────

function UnsavedChangesGuard({
  proceed, reset, active,
}: { proceed: () => void; reset: () => void; active: boolean }) {
  if (!active) return null;
  return (
    <div
      role="dialog"
      aria-modal="true"
      className="fixed inset-0 z-50 bg-bg/80 backdrop-blur-sm flex items-center justify-center p-4"
    >
      <div className="card max-w-md w-full p-6">
        <h3 className="text-lg font-semibold">Discard unsaved changes?</h3>
        <p className="text-sm text-text-secondary mt-2">
          You have entered data on this form that has not been submitted. Leaving will discard it.
        </p>
        <div className="mt-6 flex justify-end gap-2">
          <button type="button" className="btn-ghost" onClick={reset}>
            Stay
          </button>
          <button type="button" className="btn-danger" onClick={proceed}>
            Discard and leave
          </button>
        </div>
      </div>
    </div>
  );
}

