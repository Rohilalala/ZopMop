// SDUI admin API. Built on the shared axios client so it inherits Bearer auth,
// silent refresh, and the global error toast. Base prefix is `/admin`.
//
// ETag flow: getConfig() captures the `ETag` response header and returns it
// alongside the body. Callers stash it in component state and pass it back to
// patchDraft()/activate() as the `If-Match` header for optimistic locking.
import { api } from './client';

export type Env = 'production' | 'staging';
export type ConfigStatus = 'draft' | 'staged' | 'active' | 'archived';

// Mirrors bff.ConfigRecord (internal/bff/repository.go).
export type ConfigRecord = {
  id: string;
  page_id: string;
  version: string;
  env: string;
  status: ConfigStatus;
  schema_version: number;
  config_json: unknown;
  name?: string;
  description?: string;
  change_notes?: string;
  experiment_id?: string;
  created_by: string;
  created_at: string;
  staged_by?: string;
  staged_at?: string | null;
  activated_by?: string;
  activated_at?: string | null;
  archived_by?: string;
  archived_at?: string | null;
  etag: string;
};

// Mirrors bff.AuditEntry.
export type AuditEntry = {
  id: string;
  page_id: string;
  config_id?: string;
  action: string;
  actor: string;
  note?: string;
  snapshot?: unknown;
  created_at: string;
};

// Mirrors bff.AllowedActionRecord.
export type AllowedAction = {
  id: string;
  endpoint: string;
  methods: string[];
  is_active: boolean;
  created_by?: string;
  created_at: string;
};

// Validation surface returned by stage() (200 → warnings only; 400 → both).
export type ValidationResult = { errors: string[]; warnings: string[] };

// getConfig returns the record plus the ETag captured off the response header.
export type ConfigWithETag = { config: ConfigRecord; etag: string };

export type CreateDraftBody = {
  version: string;
  env?: Env;
  config_json: unknown;
  name?: string;
  description?: string;
  change_notes?: string;
  experiment_id?: string;
};

export type PatchDraftBody = {
  config_json?: unknown;
  name?: string;
  description?: string;
  change_notes?: string;
  experiment_id?: string;
};

export type PreviewParams = {
  user_id?: string;
  lat?: number;
  lon?: number;
  env?: Env;
};

export type StageResult =
  | { ok: true; warnings: string[] }
  | { ok: false; validation: ValidationResult };

export const sduiApi = {
  listPages: () =>
    api.get<{ pages: string[] }>('/admin/pages').then((r) => r.data.pages ?? []),

  listConfigs: (pageId: string, env?: Env) =>
    api
      .get<{ configs: ConfigRecord[] }>(`/admin/pages/${pageId}/configs`, {
        params: env ? { env } : undefined,
      })
      .then((r) => r.data.configs ?? []),

  // Captures the ETag response header for the optimistic-lock flow.
  getConfig: async (pageId: string, version: string, env?: Env): Promise<ConfigWithETag> => {
    const r = await api.get<ConfigRecord>(`/admin/pages/${pageId}/configs/${encodeURIComponent(version)}`, {
      params: env ? { env } : undefined,
    });
    const etag = (r.headers['etag'] as string | undefined) ?? r.data.etag ?? '';
    return { config: r.data, etag };
  },

  createDraft: (pageId: string, body: CreateDraftBody) =>
    api.post<ConfigRecord>(`/admin/pages/${pageId}/configs`, body).then((r) => r.data),

  patchDraft: (pageId: string, version: string, body: PatchDraftBody, etag: string) =>
    api
      .patch<ConfigRecord>(`/admin/pages/${pageId}/configs/${encodeURIComponent(version)}`, body, {
        headers: { 'If-Match': etag },
      })
      .then((r) => r.data),

  deleteDraft: (pageId: string, version: string) =>
    api.delete(`/admin/pages/${pageId}/configs/${encodeURIComponent(version)}`).then(() => undefined),

  // On 400 the body carries {errors, warnings} — return them rather than
  // letting the interceptor swallow them into a generic toast.
  stage: async (pageId: string, version: string): Promise<StageResult> => {
    try {
      const r = await api.put<{ config: ConfigRecord; warnings: string[] }>(
        `/admin/pages/${pageId}/configs/${encodeURIComponent(version)}/stage`,
      );
      return { ok: true, warnings: r.data.warnings ?? [] };
    } catch (err) {
      const data = (err as { response?: { status?: number; data?: { errors?: string[]; warnings?: string[] } } })
        ?.response;
      if (data?.status === 400 && data.data) {
        return {
          ok: false,
          validation: { errors: data.data.errors ?? [], warnings: data.data.warnings ?? [] },
        };
      }
      throw err;
    }
  },

  activate: (pageId: string, version: string, etag: string) =>
    api
      .put<ConfigRecord>(`/admin/pages/${pageId}/configs/${encodeURIComponent(version)}/activate`, undefined, {
        headers: { 'If-Match': etag },
      })
      .then((r) => r.data),

  // Rollback re-activates the most recently archived config for the env. The
  // backend keys off the `env` query param and ignores the :version path
  // segment, so we pass a stable literal there instead of the env (which used
  // to be sent as the version — a footgun if env ever became 'staging').
  rollback: (pageId: string, env: Env) =>
    api
      .put<ConfigRecord>(`/admin/pages/${pageId}/configs/current/rollback`, undefined, { params: { env } })
      .then((r) => r.data),

  preview: (pageId: string, version: string, params: PreviewParams) =>
    api
      .get<unknown>(`/admin/pages/${pageId}/configs/${encodeURIComponent(version)}/preview`, { params })
      .then((r) => r.data),

  auditLog: (pageId: string, limit?: number) =>
    api
      .get<{ entries: AuditEntry[] }>(`/admin/pages/${pageId}/audit-log`, {
        params: limit ? { limit } : undefined,
      })
      .then((r) => r.data.entries ?? []),

  // ── kill switches ──────────────────────────────────────────────────────
  killStatus: (pageId: string) =>
    api
      .get<{ page_id: string; kill_switch: boolean }>(`/admin/pages/${pageId}/kill-switch`)
      .then((r) => r.data.kill_switch),
  killOn: (pageId: string) =>
    api.post(`/admin/pages/${pageId}/kill-switch`).then(() => undefined),
  killOff: (pageId: string) =>
    api.delete(`/admin/pages/${pageId}/kill-switch`).then(() => undefined),

  expKillOn: (expId: string) =>
    api.post(`/admin/experiments/${expId}/kill-switch`).then(() => undefined),
  expKillOff: (expId: string) =>
    api.delete(`/admin/experiments/${expId}/kill-switch`).then(() => undefined),

  // ── allowed actions ────────────────────────────────────────────────────
  listAllowed: () =>
    api.get<{ actions: AllowedAction[] }>('/admin/allowed-actions').then((r) => r.data.actions ?? []),
  createAllowed: (body: { endpoint: string; methods: string[] }) =>
    api.post<AllowedAction>('/admin/allowed-actions', body).then((r) => r.data),
  deleteAllowed: (id: string) =>
    api.delete(`/admin/allowed-actions/${id}`).then(() => undefined),
};

export const sduiKeys = {
  pages: ['sdui', 'pages'] as const,
  configs: (pageId: string, env: Env) => ['sdui', 'configs', pageId, env] as const,
  config: (pageId: string, version: string, env: Env) =>
    ['sdui', 'config', pageId, version, env] as const,
  audit: (pageId: string) => ['sdui', 'audit', pageId] as const,
  kill: (pageId: string) => ['sdui', 'kill', pageId] as const,
  allowed: ['sdui', 'allowed-actions'] as const,
};
