// useCashfreePayment — thin wrapper around the Cashfree React Native SDK
// (Drop Checkout) plus the post-checkout backend status poll.
//
// Why a hook and not a top-level singleton:
//   The SDK callbacks (setCallback / removeCallback) are GLOBAL on the
//   native side — only one set is registered at a time. If two screens
//   register concurrently, the second wins and the first never hears back.
//   We register inside startPayment and remove BEFORE invoking user
//   callbacks, plus a useEffect cleanup tears down on unmount in case
//   the screen is left while the sheet is open.
//
// SDK env note: CFEnvironment is determined from EXPO_PUBLIC_CASHFREE_ENV
// (default "sandbox"). Backend-issued payment_session_id is only valid in
// the matching environment — keep them aligned at deploy time.

import { useCallback, useEffect, useRef } from 'react';
import {
  CFPaymentGatewayService,
  CFErrorResponse,
  type CFCallback,
} from 'react-native-cashfree-pg-sdk';
import {
  CFDropCheckoutPayment,
  CFEnvironment,
  CFSession,
  type CFTheme,
} from 'cashfree-pg-api-contract';

import { useAuth } from '../context/AuthContext';
import { getCashfreeOrderStatus, type CashfreeOrderStatus } from '../api/payments';

// Cashfree Drop Checkout theme. Header chrome can be themed; the payment-
// method body cannot be darkened — it stays white regardless of what we
// pass as backgroundColor. Body text colors must therefore be DARK so the
// "Card / UPI / Net Banking / …" labels read against Cashfree's white
// body. Setting them to brand white made the labels disappear in v2.3.x.
//
// Keep in sync with src/theme/colors.ts darkColors if the brand palette
// changes.
const ZOPMOP_THEME: CFTheme = {
  navigationBarBackgroundColor: '#0A0A0A',  // header — ZopMop dark
  navigationBarTextColor:       '#FFFFFF',  // header — readable on dark
  buttonBackgroundColor:        '#F5A300',  // primary CTA — amber
  buttonTextColor:               '#0A0A0A', // primary CTA — readable on amber
  backgroundColor:               '#FFFFFF', // body — Cashfree-default white
  primaryTextColor:              '#0A0A0A', // body labels — readable on white
  secondaryTextColor:            '#5A5A5A', // body sublabels — readable on white
};

/** Resolves once the SDK reaches a terminal state (success or failure). */
export type StartPaymentOpts = {
  payment_session_id: string;
  /** Our merchant order id (zop-<paymentID>). NOT cf_order_id. */
  order_id: string;
  on_success: (orderID: string) => void;
  on_failure: (err: CFErrorResponse) => void;
};

/** Tunables for the post-checkout poll loop. */
export type PollStatusOpts = {
  /** Hard deadline. Default 60_000 ms. */
  maxMs?: number;
  /** Initial interval. Default 3_000 ms. Subsequent intervals follow the
   *  built-in backoff schedule (3s, 3s, 5s, 5s, 5s, …). */
  intervalMs?: number;
  /** Optional cancellation. Useful when the caller unmounts mid-poll. */
  signal?: AbortSignal;
};

/** Thrown by pollStatus when the backend status is still pending after maxMs. */
export class PollTimeoutError extends Error {
  constructor() {
    super('cashfree status still pending after maxMs');
    this.name = 'PollTimeoutError';
  }
}

/** Thrown by pollStatus when the caller aborts mid-loop. */
export class PollAbortedError extends Error {
  constructor() {
    super('cashfree status poll aborted');
    this.name = 'PollAbortedError';
  }
}

function resolveEnvironment(): CFEnvironment {
  const raw = (process.env.EXPO_PUBLIC_CASHFREE_ENV ?? 'sandbox').toLowerCase();
  return raw === 'production' ? CFEnvironment.PRODUCTION : CFEnvironment.SANDBOX;
}

// Backoff schedule for pollStatus. Tight at start (webhook lands in the
// first 3-6s in 99% of real cases), then loosens to reduce server load.
const BACKOFF_SCHEDULE_MS = [3000, 3000, 5000, 5000, 5000];

function delayMs(attempt: number, fallbackMs: number): number {
  return BACKOFF_SCHEDULE_MS[attempt] ?? fallbackMs;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new PollAbortedError());
      return;
    }
    const t = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(new PollAbortedError());
    };
    signal?.addEventListener('abort', onAbort);
  });
}

export function useCashfreePayment() {
  const { token } = useAuth();
  // Dedupe-in-flight guard: a double-tap on the Continue button must not
  // open a second SDK sheet (would corrupt the global callback state).
  const inFlightRef = useRef<Promise<void> | null>(null);

  // Cleanup on unmount. The SDK keeps callbacks alive across React unmounts;
  // this is the safety valve for "user backgrounds the app while sheet is
  // open, comes back, and the screen has unmounted."
  useEffect(() => {
    return () => {
      try {
        CFPaymentGatewayService.removeCallback();
      } catch {
        // ignore — native module may already be torn down
      }
    };
  }, []);

  const startPayment = useCallback((opts: StartPaymentOpts): Promise<void> => {
    if (inFlightRef.current) {
      // Concurrent invocation — return the existing promise so the second
      // tap awaits the first instead of opening a duplicate sheet.
      return inFlightRef.current;
    }

    const promise = new Promise<void>((resolve) => {
      const callbacks: CFCallback = {
        onVerify: (orderID: string) => {
          // Tear down BEFORE invoking caller — caller may chain into another
          // payment, and a stale callback would intercept the next session.
          try {
            CFPaymentGatewayService.removeCallback();
          } catch {
            // ignore
          }
          inFlightRef.current = null;
          opts.on_success(orderID);
          resolve();
        },
        onError: (err: CFErrorResponse) => {
          try {
            CFPaymentGatewayService.removeCallback();
          } catch {
            // ignore
          }
          inFlightRef.current = null;
          opts.on_failure(err);
          resolve();
        },
      };

      try {
        CFPaymentGatewayService.setCallback(callbacks);
        const session = new CFSession(
          opts.payment_session_id,
          opts.order_id,
          resolveEnvironment(),
        );
        const drop = new CFDropCheckoutPayment(session, null, ZOPMOP_THEME);
        CFPaymentGatewayService.doPayment(drop);
      } catch (err) {
        // Synchronous SDK error before native sheet opens (e.g. linking failure).
        try {
          CFPaymentGatewayService.removeCallback();
        } catch {
          // ignore
        }
        inFlightRef.current = null;
        const wrapped = new CFErrorResponse();
        wrapped.fromJSON(
          JSON.stringify({
            status: 'FAILED',
            code: 'sdk_init_error',
            message: err instanceof Error ? err.message : 'SDK initialisation failed',
            type: 'request_failed',
          }),
        );
        opts.on_failure(wrapped);
        resolve();
      }
    });

    inFlightRef.current = promise;
    return promise;
  }, []);

  /**
   * Polls the backend status endpoint until the payment reaches a terminal
   * state (success / failed / refunded) or the deadline elapses.
   *
   * Cashfree's SDK fires onVerify before the gateway-side webhook lands on
   * our server, so we cannot trust the SDK callback alone. The ledger is
   * the canonical source — webhook + UpdateStatusByGatewayRefTx flips the
   * row to 'success' inside a transaction. This loop reads that flip.
   */
  const pollStatus = useCallback(
    async (orderID: string, opts: PollStatusOpts = {}): Promise<CashfreeOrderStatus> => {
      if (!token) {
        throw new Error('not authenticated');
      }
      const maxMs = opts.maxMs ?? 60_000;
      const fallback = opts.intervalMs ?? 3_000;
      const deadline = Date.now() + maxMs;
      let attempt = 0;

      while (Date.now() < deadline) {
        if (opts.signal?.aborted) {
          throw new PollAbortedError();
        }
        try {
          const snapshot = await getCashfreeOrderStatus(token, orderID);
          if (snapshot.status !== 'pending') {
            return snapshot;
          }
        } catch (err) {
          // Network blip / 5xx — the apiFetch wrapper already retried on
          // transport errors. Swallow + try again on next interval; the
          // overall maxMs guard prevents an infinite loop.
          console.warn('[cashfree] status poll error', err);
        }
        const wait = delayMs(attempt, fallback);
        attempt += 1;
        await sleep(wait, opts.signal);
      }

      throw new PollTimeoutError();
    },
    [token],
  );

  return { startPayment, pollStatus };
}
