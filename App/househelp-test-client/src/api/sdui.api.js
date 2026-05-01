import client from './client';

// ── Pages ─────────────────────────────────────────────────────────────────────
export const listSduiPages = async () => {
  const { data } = await client.get('/admin/pages');
  return data;
};

// ── Configs ───────────────────────────────────────────────────────────────────
export const listConfigs = async (pageId, params) => {
  const { data } = await client.get(`/admin/pages/${pageId}/configs`, { params });
  return data;
};

export const getConfig = async (pageId, version, params) => {
  const { data } = await client.get(`/admin/pages/${pageId}/configs/${version}`, { params });
  return data;
};

export const createDraft = async (pageId, body) => {
  const { data } = await client.post(`/admin/pages/${pageId}/configs`, body);
  return data;
};

export const updateDraft = async (pageId, version, body, etag) => {
  const { data } = await client.patch(
    `/admin/pages/${pageId}/configs/${version}`,
    body,
    { headers: etag ? { 'If-Match': etag } : {} },
  );
  return data;
};

export const deleteDraft = async (pageId, version) => {
  const { data } = await client.delete(`/admin/pages/${pageId}/configs/${version}`);
  return data;
};

// ── Lifecycle ─────────────────────────────────────────────────────────────────
export const stageConfig = async (pageId, version) => {
  const { data } = await client.put(`/admin/pages/${pageId}/configs/${version}/stage`);
  return data;
};

export const activateConfig = async (pageId, version, etag) => {
  const { data } = await client.put(
    `/admin/pages/${pageId}/configs/${version}/activate`,
    undefined,
    { headers: etag ? { 'If-Match': etag } : {} },
  );
  return data;
};

export const rollbackConfig = async (pageId, version) => {
  const { data } = await client.put(`/admin/pages/${pageId}/configs/${version}/rollback`);
  return data;
};

export const previewConfig = async (pageId, version, params) => {
  const { data } = await client.get(`/admin/pages/${pageId}/configs/${version}/preview`, { params });
  return data;
};

// ── Audit Log ─────────────────────────────────────────────────────────────────
export const getSduiAuditLog = async (pageId, params) => {
  const { data } = await client.get(`/admin/pages/${pageId}/audit-log`, { params });
  return data;
};

// ── Kill switch (page) ────────────────────────────────────────────────────────
export const getKillSwitch = async (pageId) => {
  const { data } = await client.get(`/admin/pages/${pageId}/kill-switch`);
  return data;
};

export const setKillSwitch = async (pageId) => {
  const { data } = await client.post(`/admin/pages/${pageId}/kill-switch`);
  return data;
};

export const clearKillSwitch = async (pageId) => {
  const { data } = await client.delete(`/admin/pages/${pageId}/kill-switch`);
  return data;
};

// ── Kill switch (experiment) ──────────────────────────────────────────────────
export const setExpKillSwitch = async (expId) => {
  const { data } = await client.post(`/admin/experiments/${expId}/kill-switch`);
  return data;
};

export const clearExpKillSwitch = async (expId) => {
  const { data } = await client.delete(`/admin/experiments/${expId}/kill-switch`);
  return data;
};

// ── Allowed actions ───────────────────────────────────────────────────────────
export const listAllowedActions = async () => {
  const { data } = await client.get('/admin/allowed-actions');
  return data;
};

export const addAllowedAction = async (body) => {
  const { data } = await client.post('/admin/allowed-actions', body);
  return data;
};

export const deleteAllowedAction = async (id) => {
  const { data } = await client.delete(`/admin/allowed-actions/${id}`);
  return data;
};
