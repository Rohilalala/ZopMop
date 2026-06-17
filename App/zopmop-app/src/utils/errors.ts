// friendlyError — the ONE place that turns a thrown error into something a user
// should read. Raw error text (backend strings like "invalid request body",
// JSON parse failures, network internals, stack messages) MUST NOT reach a
// toast/alert — it confuses users and leaks implementation detail. Technical
// detail is logged for devs/admin instead; the user sees a plain, actionable
// sentence.
//
// Usage at a catch site:
//   showError(friendlyError(err, 'Could not save your address. Please try again.'))
// Pass a context-specific, human fallback. friendlyError will:
//   1. log the real error (dev console now; wire to Sentry/backend later),
//   2. map a known error CODE to friendlier copy if we have one,
//   3. otherwise return your fallback — never the raw message.

// Known machine codes (from api/* throwers + backend `code` fields) → human copy.
// Add to this as new coded errors appear; everything else uses the fallback.
const CODE_MESSAGES: Record<string, string> = {
  invalid_otp: 'That code is incorrect. Check it with the customer and try again.',
  payment_required: 'Payment is needed before this can be finished.',
  UNPAID_BOOKINGS: 'Please settle your pending payment before booking again.',
  INSUFFICIENT_WALLET_BALANCE: 'Your wallet balance is too low. Top up or pick another payment method.',
  OUTSIDE_ARRIVED_RADIUS: "You're too far from the location to do this yet.",
  zero_amount: 'There is nothing left to pay on this booking.',
  amount_invalid: 'That amount isn’t allowed. Please pick a different amount.',
};

const NETWORK_MESSAGE = 'Check your connection and try again.';

function rawCode(err: unknown): string | undefined {
  if (err && typeof err === 'object') {
    const c = (err as { code?: unknown }).code;
    if (typeof c === 'string' && c) return c;
  }
  return undefined;
}

function isNetworkish(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const name = (err as { name?: unknown }).name;
  const status = (err as { status?: unknown }).status;
  if (name === 'AbortError') return true;
  if (status === 0) return true;
  const msg = (err as { message?: unknown }).message;
  if (typeof msg === 'string' && /network request failed|failed to fetch|timed out|timeout/i.test(msg)) {
    return true;
  }
  return false;
}

// Technical / framework noise that must NEVER reach a user, even though it
// arrives as a short string. These come from body parsers, validators, the
// gateway, or crashes — not from business logic.
const TECHNICAL = /json|sql|request body|validation failed|unexpected|undefined|null pointer|nil |econn|stack|panic|internal server|cannot read|is not a function|syntax|parse|deserialize|unmarshal|500|502|503|504|status code|fetch failed|xmlhttp/i;

// A backend message worth showing verbatim: a short, plain-language sentence
// (has letters + a space), not technical noise. The Go handlers DO write
// user-facing business strings ("maximum active bookings limit reached",
// "slot no longer available", "please select a time slot") — those are
// genuinely more helpful than a generic fallback, so surface them.
function looksUserFacing(msg: unknown): msg is string {
  if (typeof msg !== 'string') return false;
  const m = msg.trim();
  if (m.length < 4 || m.length > 140) return false;
  if (TECHNICAL.test(m)) return false;
  return /[a-zA-Z]/.test(m) && /\s/.test(m); // a phrase, not a token dump
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/**
 * Turn any thrown value into a user-facing message. Logs the raw error for
 * devs/admin. Prefers, in order: a mapped error code, a network hint, a
 * specific-but-clean backend business message, then the caller's fallback.
 * Never surfaces technical/raw text.
 */
export function friendlyError(err: unknown, fallback: string): string {
  // Devs/admin see the real thing; the user never does (unless it's clean).
  if (__DEV__) {
    // eslint-disable-next-line no-console
    console.warn('[handled-error]', err);
  }
  const code = rawCode(err);
  if (code && CODE_MESSAGES[code]) return CODE_MESSAGES[code];
  if (isNetworkish(err)) return NETWORK_MESSAGE;
  // Surface a clean, specific backend reason when there is one — these are far
  // more useful than "please try again". Technical noise is filtered out above.
  const msg = (err && typeof err === 'object') ? (err as { message?: unknown }).message : undefined;
  if (looksUserFacing(msg)) return capitalize(msg.trim());
  return fallback;
}
