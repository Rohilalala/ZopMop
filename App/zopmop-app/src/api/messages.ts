import { apiFetch } from './client';
import { BASE_URL, authHeaders, validateShape } from './config';

export interface BookingMessage {
  id: string;
  booking_id: string;
  sender_id: string;
  sender_role: 'customer' | 'pro';
  body: string;
  created_at: string;
}

const REQUIRED_KEYS: (keyof BookingMessage)[] = [
  'id', 'booking_id', 'sender_id', 'sender_role', 'body', 'created_at',
];

/** GET /bookings/:id/messages — chat history (oldest → newest). */
export async function listMessages(token: string, bookingId: string): Promise<BookingMessage[]> {
  const res = await apiFetch(`${BASE_URL}/bookings/${bookingId}/messages`, {
    headers: authHeaders(token),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error((err as any).error ?? 'Failed to load messages');
  }
  const data = await res.json();
  if (!Array.isArray(data.messages)) throw new Error('Invalid response: messages is not an array');
  return (data.messages as unknown[]).map((m) => validateShape<BookingMessage>(m, REQUIRED_KEYS));
}

/** POST /bookings/:id/messages — send a chat message. */
export async function sendMessage(
  token: string,
  bookingId: string,
  body: string,
): Promise<BookingMessage> {
  const res = await apiFetch(`${BASE_URL}/bookings/${bookingId}/messages`, {
    method: 'POST',
    headers: { ...authHeaders(token), 'Content-Type': 'application/json' },
    body: JSON.stringify({ body }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error((err as any).error ?? 'Failed to send message');
  }
  return validateShape<BookingMessage>(await res.json(), REQUIRED_KEYS);
}
