import client from './client';

export const createBooking = async (postData) => {
  const { data } = await client.post('/bookings', postData);
  return data;
};

export const getBooking = async (id) => {
  const { data } = await client.get(`/bookings/${id}`);
  return data;
};

export const listBookings = async () => {
  const { data } = await client.get('/bookings');
  return data;
};
