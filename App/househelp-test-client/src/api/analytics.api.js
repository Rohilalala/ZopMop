import client from './client';

export const getAnalyticsOverview = async (days = 7) => {
  const { data } = await client.get('/admin/analytics/overview', { params: { days } });
  return data;
};

export const getAnalyticsFunnel = async (days = 30) => {
  const { data } = await client.get('/admin/analytics/funnel', { params: { days } });
  return data;
};

export const getBookingTrends = async (days = 30) => {
  const { data } = await client.get('/admin/analytics/bookings', { params: { days } });
  return data;
};

export const getWorkerPerformance = async (days = 30, limit = 20) => {
  const { data } = await client.get('/admin/analytics/workers', { params: { days, limit } });
  return data;
};

export const getOperationalMetrics = async (days = 7) => {
  const { data } = await client.get('/admin/analytics/operations', { params: { days } });
  return data;
};

export const getRevenueTrends = async (days = 30) => {
  const { data } = await client.get('/admin/analytics/revenue', { params: { days } });
  return data;
};
