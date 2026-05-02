import { useEffect, useRef, useState, useCallback } from 'react';
import { BASE_URL } from '../api/config';

export type BackendStatus = 'unknown' | 'up' | 'down';

const HEALTH_URL = BASE_URL.replace(/\/api\/v\d+\/?$/, '') + '/health';
const PROBE_TIMEOUT_MS = 4_000;
const POLL_DOWN_MS = 5_000;
const POLL_UP_MS = 30_000;

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
    setStatus(ok ? 'up' : 'down');
    scheduleNext(ok);
  }, [scheduleNext]);

  const retry = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    setStatus('unknown');
    tick();
  }, [tick]);

  useEffect(() => {
    mounted.current = true;
    tick();

    // Subscribe to external "I just saw a network error" signals so any
    // failed API call flips us to 'down' immediately, without waiting for
    // the next poll interval.
    _onExternalDown = () => {
      if (!mounted.current) return;
      setStatus('down');
      scheduleNext(false);
    };

    return () => {
      mounted.current = false;
      if (timer.current) clearTimeout(timer.current);
      _onExternalDown = null;
    };
  }, [tick, scheduleNext]);

  return { status, retry };
}
