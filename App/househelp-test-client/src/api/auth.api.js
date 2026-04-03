import client from './client';

export const sendOTP = async (phone) => {
  const { data } = await client.post('/auth/send-otp', { phone });
  return data;
};

export const verifyOTP = async (phone, otp) => {
  const { data } = await client.post('/auth/verify-otp', { phone, otp });
  return data;
};
