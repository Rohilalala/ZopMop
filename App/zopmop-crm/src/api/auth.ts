import { api } from './client';
import type { Admin } from '@/store/auth';

export type LoginResponse = {
  challenge_token: string;
  totp_enrolled: boolean;
  otpauth_url?: string;
};

export type AuthSuccess = {
  access_token: string;
  expires_at: string;
  admin: Admin;
};

export async function login(email: string, password: string): Promise<LoginResponse> {
  const res = await api.post('/admin/auth/login', { email, password });
  return res.data;
}

export async function verifyTotp(challengeToken: string, code: string): Promise<AuthSuccess> {
  const res = await api.post('/admin/auth/totp/verify', {
    challenge_token: challengeToken,
    code,
  });
  return res.data;
}

export async function logout(): Promise<void> {
  await api.post('/admin/auth/logout');
}

export type Session = {
  id: string;
  user_agent?: string | null;
  ip_address?: string | null;
  issued_at: string;
  last_used_at: string;
  expires_at: string;
  is_current: boolean;
};

export async function listSessions(): Promise<Session[]> {
  const res = await api.get<{ sessions: Session[] }>('/admin/auth/sessions');
  return res.data.sessions;
}

export async function revokeSession(id: string): Promise<void> {
  await api.delete(`/admin/auth/sessions/${id}`);
}
