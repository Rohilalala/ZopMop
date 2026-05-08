import { useEffect, useRef, useState, useCallback } from 'react';
import { BASE_URL } from '../api/config';

export type BackendStatus = 'unknown' | 'up' | 'down';

const HEALTH_URL = BASE_URL.replace(/\/api\/v\d+\/?$/, '') + '/health';
// Railway free-tier cold-starts can take 5–10s after idle. A 4s probe timeout
// reliably false-positives "down" on the very first launch after the backend
// has been asleep, so we give the wake-up a realistic budget.
const PROBE_TIMEOUT_MS = 12_000;
const POLL_DOWN_MS = 5_000;
const POLL_UP_MS = 30_000;
// Number of consecutive failed probes before we flip to 'down'. Catches the
// transient first-fetch failure that happens during cold-start without
// gaslighting the user with the dead-Zop screen.
const FAILURE_THRESHOLD = 2;

// External signal — apiFetch (or anything else) calls reportBackendDown() when
// it observes a network failure. The active hook instance subscribes and flips
// to 'down' immediately, then polling resumes recovery checks.
let _onExternalDown: (() => void) | null = null;

export function reportBackendDown() {
  _onExternalDown?.();
}

async function probe(): Promise<boolean> {
  const ctrl = new AbortController();
  const tid = setTimeout(() => ctrl.abort(), PROBE_TIMEOUT_MS);
  try {
    const res = await fetch(HEALTH_URL, { signal: ctrl.signal });
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(tid);
  }
}

export function useBackendHealth() {
  const [status, setStatus] = useState<BackendStatus>('unknown');
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mounted = useRef(true);
  const consecutiveFailures = useRef(0);

  const scheduleNext = useCallback((ok: boolean) => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(tick, ok ? POLL_UP_MS : POLL_DOWN_MS);
  // tick is hoisted below; eslint-disable-next-line not used — fn is stable
  // because the closure only references refs/state setters.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const tick = useCallback(async () => {
    const ok = await probe();
    if (!mounted.current) return;
    if (ok) {
      consecutiveFailures.current = 0;
      setStatus('up');
    } else {
      consecutiveFailures.current += 1;
      // Stay in 'unknown' until the failure threshold is crossed so a single
      // cold-start hiccup doesn't blank the UI with the dead-Zop screen.
      if (consecutiveFailures.current >= FAILURE_THRESHOLD) {
        setStatus('down');
      }
    }
    scheduleNext(ok);
  }, [scheduleNext]);

  const retry = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    consecutiveFailures.current = 0;
    setStatus('unknown');
    tick();
  }, [tick]);

  useEffect(() => {
    mounted.current = true;
    tick();

    // Subscribe to external "I just saw a 5xx" signals. Don't flip directly —
    // a single 5xx can be Railway's edge proxy returning 502/503 during a
    // container cold-start (the container is up by the time /health responds).
    // Trigger an immediate probe instead; the probe result is the source of
    // truth. If /health passes, the 5xx was transient — keep the UI alive.
    _onExternalDown = () => {
      if (!mounted.current) return;
      if (timer.current) clearTimeout(timer.current);
      tick();
    };

    return () => {
      mounted.current = false;
      if (timer.current) clearTimeout(timer.current);
      _onExternalDown = null;
    };
  }, [tick, scheduleNext]);

  return { status, retry };
}
