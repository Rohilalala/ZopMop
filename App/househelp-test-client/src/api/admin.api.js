import client from './client';

// ── Dashboard ─────────────────────────────────────────────────────────────────
export const getDashboard = async () => {
  const { data } = await client.get('/admin/dashboard');
  return data;
};

// ── Users ─────────────────────────────────────────────────────────────────────
export const getUsers = async (params) => {
  const { data } = await client.get('/admin/users', { params });
  return data;
};

export const suspendUser = async (id) => {
  const { data } = await client.patch(`/admin/users/${id}/suspend`);
  return data;
};

export const unsuspendUser = async (id) => {
  const { data } = await client.patch(`/admin/users/${id}/unsuspend`);
  return data;
};

// ── Helpers ───────────────────────────────────────────────────────────────────
export const getHelpers = async (params) => {
  const { data } = await client.get('/admin/helpers', { params });
  return data;
};

export const getPendingHelpers = async (params) => {
  const { data } = await client.get('/admin/helpers/pending', { params });
  return data;
};

export const approveHelper = async (id) => {
  const { data } = await client.patch(`/admin/helpers/${id}/approve`);
  return data;
};

export const rejectHelper = async (id) => {
  const { data } = await client.patch(`/admin/helpers/${id}/reject`);
  return data;
};

// ── Refunds ───────────────────────────────────────────────────────────────────
export const listRefunds = async (params) => {
  const { data } = await client.get('/admin/refunds', { params });
  return data;
};

export const settleRefund = async (id) => {
  const { data } = await client.post(`/admin/refunds/${id}/settle`);
  return data;
};

// ── Bookings ──────────────────────────────────────────────────────────────────
export const getAdminBookings = async (params) => {
  const { data } = await client.get('/admin/bookings', { params });
  return data;
};

export const cancelAdminBooking = async (id) => {
  const { data } = await client.patch(`/admin/bookings/${id}/cancel`);
  return data;
};

// ── Audit Log ─────────────────────────────────────────────────────────────────
export const getAuditLog = async (params) => {
  const { data } = await client.get('/admin/audit-log', { params });
  return data;
};

// ── Config ────────────────────────────────────────────────────────────────────
export const getConfig = async () => {
  const { data } = await client.get('/admin/config');
  return data;
};

export const updateConfig = async (key, value) => {
  const { data } = await client.patch(`/admin/config/${key}`, { value });
  return data;
};

export const bulkUpdateConfig = async (configs) => {
  const { data } = await client.post('/admin/config/bulk', { configs });
  return data;
};

// ── Content ───────────────────────────────────────────────────────────────────
export const getBanners = async () => {
  const { data } = await client.get('/admin/content/banners');
  return data;
};

export const createBanner = async (postData) => {
  const { data } = await client.post('/admin/content/banners', postData);
  return data;
};

export const updateBanner = async (id, postData) => {
  const { data } = await client.patch(`/admin/content/banners/${id}`, postData);
  return data;
};

export const deleteBanner = async (id) => {
  const { data } = await client.delete(`/admin/content/banners/${id}`);
  return data;
};

export const getScreens = async () => {
  const { data } = await client.get('/admin/content/screens');
  return data;
};

export const updateScreen = async (key, content) => {
  const { data } = await client.patch(`/admin/content/screens/${key}`, { content });
  return data;
};

// ── Services ──────────────────────────────────────────────────────────────────
export const getAdminServices = async () => {
  const { data } = await client.get('/admin/services');
  return data;
};

export const updateService = async (id, payload) => {
  const { data } = await client.patch(`/admin/services/${id}`, payload);
  return data;
};

export const createService = async (payload) => {
  const { data } = await client.post('/admin/services', payload);
  return data;
};

export const deleteService = async (id) => {
  const { data } = await client.delete(`/admin/services/${id}`);
  return data;
};

// ── Promotions ────────────────────────────────────────────────────────────────
export const getPromotions = async (params) => {
  const { data } = await client.get('/admin/promotions', { params });
  return data;
};

export const createPromotion = async (postData) => {
  const { data } = await client.post('/admin/promotions', postData);
  return data;
};

export const updatePromotion = async (id, postData) => {
  const { data } = await client.patch(`/admin/promotions/${id}`, postData);
  return data;
};

export const disablePromotion = async (id) => {
  const { data } = await client.patch(`/admin/promotions/${id}/disable`);
  return data;
};

// ── Notifications ─────────────────────────────────────────────────────────────
export const broadcastNotification = async ({ title, body, target }) => {
  const { data } = await client.post('/admin/notifications/broadcast', { title, body, target });
  return data;
};
