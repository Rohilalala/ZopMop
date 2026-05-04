import { BASE_URL, authHeaders } from '../api/config';

export interface ZopQuickReply {
  label: string;
  value: string;
}

export interface ZopChatResponse {
  reply: string;
  action_taken: string | null;
  data: unknown | null;
  quick_replies: ZopQuickReply[] | null;
}

// Zop calls fan out to DeepSeek with multi-iter tool loops — easily 10-20s.
// apiFetch enforces a 10s timeout that aborts these mid-flight, so Zop uses
// raw fetch with a longer 90s budget aligned with the server's per-route
// Timeout middleware.
const ZOP_TIMEOUT_MS = 90_000;

/**
 * Send a message to the Zop AI assistant. The backend handles rate-limiting,
 * prompt cleaning, agent loop, and history persistence keyed by sessionId.
 *
 * Throws on non-2xx responses with the server's error message when present.
 */
export async function sendZopMessage(
  token: string,
  message: string,
  sessionId: string,
): Promise<ZopChatResponse> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), ZOP_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(`${BASE_URL}/zop/chat`, {
      method: 'POST',
      headers: authHeaders(token),
      body: JSON.stringify({ message, session_id: sessionId }),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeoutId);
  }
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error((err as { error?: string }).error ?? 'Zop is unavailable right now');
  }
  const json = (await res.json()) as Partial<ZopChatResponse>;
  if (typeof json.reply !== 'string') {
    throw new Error('Zop returned an invalid response');
  }
  return {
    reply: json.reply,
    action_taken: json.action_taken ?? null,
    data: json.data ?? null,
    quick_replies: Array.isArray(json.quick_replies) ? json.quick_replies : null,
  };
}

/**
 * Clear all of the user's Zop chat history server-side. Customer data
 * (bookings, addresses, profile) is NOT affected — only conversational
 * memory in Redis. Best-effort: errors are swallowed so a redis blip can't
 * block the local clear.
 */
export async function clearZopHistory(token: string): Promise<void> {
  try {
    await fetch(`${BASE_URL}/zop/history`, {
      method: 'DELETE',
      headers: authHeaders(token),
    });
  } catch {
    // ignore — local clear still proceeds
  }
}
