import client from './client';

export const getDashboard = async () => {
  const { data } = await client.get('/admin/dashboard');
  return data;
};

export const getUsers = async (params) => {
  const { data } = await client.get('/admin/users', { params });
  return data;
};

export const suspendUser = async (id) => {
  const { data } = await client.post(`/admin/users/${id}/suspend`);
  return data;
};

export const unsuspendUser = async (id) => {
  const { data } = await client.post(`/admin/users/${id}/unsuspend`);
  return data;
};

export const getHelpers = async () => {
  const { data } = await client.get('/admin/helpers');
  return data;
};

export const getBookings = async (params) => {
  const { data } = await client.get('/admin/bookings', { params });
  return data;
};

export const getAuditLog = async () => {
  const { data } = await client.get('/admin/audit-log');
  return data;
};

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

export const getServices = async () => {
  const { data } = await client.get('/admin/services');
  return data;
};

export const createService = async (postData) => {
  const { data } = await client.post('/admin/services', postData);
  return data;
};

export const updateService = async (id, postData) => {
  const { data } = await client.patch(`/admin/services/${id}`, postData);
  return data;
};

export const deleteService = async (id) => {
  const { data } = await client.delete(`/admin/services/${id}`);
  return data;
};

export const getPromotions = async () => {
  const { data } = await client.get('/admin/promotions');
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
  const { data } = await client.post(`/admin/promotions/${id}/disable`);
  return data;
};
