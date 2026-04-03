import client from './client';

export const getConfig = async () => {
  const { data } = await client.get('/app/config');
  return data;
};

export const getHome = async () => {
  const { data } = await client.get('/app/home');
  return data;
};

export const getServices = async () => {
  const { data } = await client.get('/app/services');
  return data;
};

export const getFAQs = async () => {
  const { data } = await client.get('/app/faqs');
  return data;
};

export const getScreen = async (key) => {
  const { data } = await client.get(`/app/screens/${key}`);
  return data;
};
