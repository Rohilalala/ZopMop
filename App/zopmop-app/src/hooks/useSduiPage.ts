// useSduiPage — fetches and caches an SDUI page from the BFF.
//
// Pipeline (matches docs/SDUI.md §11 + §14):
//
//   1. On mount: read AsyncStorage cache (key `sdui:<pageId>`).
//      └─ schemaVersion match → setPage immediately, then refetch in background.
//      └─ schemaVersion miss  → drop cache, fetch fresh.
//
//   2. Network fetch: GET ${BASE_URL}/page/<pageId>?lat=..&lon=..
//      Headers:
//        X-Client-Version  — from expo-constants
//        X-Screen-Width    — from Dimensions
//        Accept-Language   — best-effort device locale
//        If-None-Match     — last received ETag (kept in a ref)
//
//   3. 304 Not Modified  → keep current page (no state churn).
//      200 OK            → sanitizePage; if config_hash unchanged, no-op;
//                          else setPage + AsyncStorage.setItem.
//      Network error     → keep cached if any; setError if no cache.
//
//   4. fetchSection (lazy): GET /page/<pageId>/section/<sectionId>
//      Timeout 5s, retries 2 (400ms / 800ms backoff). All retries fail →
//      logEvent('sdui_lazy_section_failed', { section_id }) and return null.
//
//   5. CACHE_SCHEMA_VERSION — bump whenever SduiSection wire shape changes.
//      Reads with mismatched schemaVersion are dropped and refetched.

import { useCallback, useEffect, useRef, useState } from 'react';
import { Dimensions, Platform } from 'react-native';
// AsyncStorage is a peer-installed dep; require lazily so this module loads
// even if the package hasn't finished installing during a fresh checkout.
import AsyncStorage from '@react-native-async-storage/async-storage';
import Constants from 'expo-constants';

import { BASE_URL } from '../api/config';
import { logEvent } from '../analytics/impressionTracker';
import { sanitizePage } from '../sdui/safeguards';
import type { SduiLazySectionResponse, SduiPage } from '../sdui/types';

export const CACHE_SCHEMA_VERSION = 4;

const PAGE_FETCH_TIMEOUT_MS  = 8_000;
const LAZY_FETCH_TIMEOUT_MS  = 5_000;
const LAZY_RETRY_DELAYS_MS   = [400, 800];

interface CacheEnvelope {
  schemaVersion: number;
  cachedAt:      number;
  page:          SduiPage;
  etag?:         string;
}

// Module-level in-memory cache. Survives across screen mounts so
// re-navigating to a previously loaded page renders synchronously without
// showing the skeleton again. AsyncStorage is still used as the durable
// cross-launch cache below; this layer just removes the async read flicker.
const memPageCache: Map<string, SduiPage> = new Map();
const memEtagCache: Map<string, string>   = new Map();

export interface UseSduiPageResult {
  page:    SduiPage | null;
  loading: boolean;
  error:   string | null;
  refetch: () => Promise<void>;
  fetchSection: (
    sectionId: string,
    cursor?: string,
  ) => Promise<SduiLazySectionResponse | null>;
}

interface UseSduiPageOpts {
  lat?: number;
  lon?: number;
  initialPage?: SduiPage | null;
}

// ── helpers ────────────────────────────────────────────────────────────────

function cacheKey(pageId: string): string {
  return `sdui:${pageId}`;
}

function getAppVersion(): string {
  return (
    (Constants?.expoConfig?.version as string | undefined) ??
    ((Constants as unknown as { manifest?: { version?: string } }).manifest?.version) ??
    'unknown'
  );
}

function getScreenWidth(): string {
  try {
    return String(Math.round(Dimensions.get('window').width));
  } catch {
    return '0';
  }
}

function getLocale(): string {
  // expo-constants doesn't expose locale directly across SDK versions; the
  // BFF accepts a missing header and defaults to en-IN, so a best-effort
  // fallback is fine.
  const fromConstants =
    (Constants as unknown as { manifest?: { locale?: string } }).manifest?.locale;
  if (fromConstants) return fromConstants;
  return Platform.OS === 'ios' ? 'en-IN' : 'en-IN';
}

function buildPageUrl(pageId: string, opts?: UseSduiPageOpts): string {
  const params = new URLSearchParams();
  if (opts?.lat !== undefined) params.set('lat', String(opts.lat));
  if (opts?.lon !== undefined) params.set('lon', String(opts.lon));
  const qs = params.toString();
  return `${BASE_URL}/sdui/page/${encodeURIComponent(pageId)}${qs ? `?${qs}` : ''}`;
}

function buildSectionUrl(
  pageId:    string,
  sectionId: string,
  cursor:    string | undefined,
  opts:      UseSduiPageOpts | undefined,
  snapshotAt: string | undefined,
): string {
  const params = new URLSearchParams();
  if (cursor)             params.set('cursor', cursor);
                          params.set('limit',  '12');
  if (opts?.lat != null)  params.set('lat',  String(opts.lat));
  if (opts?.lon != null)  params.set('lon',  String(opts.lon));
  if (snapshotAt)         params.set('snapshot_at', snapshotAt);
  return `${BASE_URL}/sdui/page/${encodeURIComponent(pageId)}/section/${encodeURIComponent(sectionId)}?${params.toString()}`;
}

async function fetchWithTimeout(
  url:       string,
  init:      RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

// ── hook ───────────────────────────────────────────────────────────────────

export function useSduiPage(
  pageId: string,
  opts?:  UseSduiPageOpts,
): UseSduiPageResult {
  const initialPage = opts?.initialPage ?? memPageCache.get(pageId) ?? null;
  const [page,    setPage]    = useState<SduiPage | null>(initialPage);
  const [loading, setLoading] = useState<boolean>(initialPage == null);
  const [error,   setError]   = useState<string | null>(null);

  // Most recent ETag from server; sent on subsequent requests so the BFF can
  // 304 us. Kept in a ref to avoid re-renders.
  const etagRef = useRef<string | null>(memEtagCache.get(pageId) ?? null);

  // Stable references to opts values so the effect re-runs only when
  // coordinates actually change, not on every render.
  const lat = opts?.lat;
  const lon = opts?.lon;

  // Track latest in-flight request so a stale response doesn't clobber a
  // newer one (e.g. user changes location quickly).
  const requestSeq = useRef(0);

  const doFetch = useCallback(
    async (background: boolean): Promise<void> => {
      const seq = ++requestSeq.current;
      if (!background) setLoading(true);

      try {
        const headers: Record<string, string> = {
          'X-Client-Version': getAppVersion(),
          'X-Screen-Width':   getScreenWidth(),
          'Accept-Language':  getLocale(),
        };
        if (etagRef.current) headers['If-None-Match'] = etagRef.current;

        const res = await fetchWithTimeout(
          buildPageUrl(pageId, { lat, lon }),
          { method: 'GET', headers },
          PAGE_FETCH_TIMEOUT_MS,
        );

        if (seq !== requestSeq.current) return;

        if (res.status === 304) {
          // Server says nothing changed; keep current page.
          setError(null);
          return;
        }

        if (!res.ok) {
          // Keep any cached page; surface error only if we have nothing.
          setError(`SDUI fetch failed: ${res.status}`);
          return;
        }

        const newEtag = res.headers.get('ETag') ?? res.headers.get('etag');
        if (newEtag) etagRef.current = newEtag;

        const json = await res.json();
        const sanitised = sanitizePage(json);
        if (!sanitised) {
          setError('Invalid SDUI page payload');
          return;
        }

        // Compare config_hash to skip identical pages (preserves stable refs
        // so memoised SectionRenderers don't re-render).
        setPage((prev) => {
          if (prev && prev.config_hash === sanitised.config_hash) {
            memPageCache.set(pageId, prev);
            return prev;
          }
          memPageCache.set(pageId, sanitised);
          return sanitised;
        });
        if (etagRef.current) memEtagCache.set(pageId, etagRef.current);
        setError(null);

        // Persist for next launch.
        try {
          const envelope: CacheEnvelope = {
            schemaVersion: CACHE_SCHEMA_VERSION,
            cachedAt:      Date.now(),
            page:          sanitised,
            etag:          etagRef.current ?? undefined,
          };
          await AsyncStorage.setItem(cacheKey(pageId), JSON.stringify(envelope));
        } catch {
          // Cache write is best-effort.
        }
      } catch (err) {
        if (seq !== requestSeq.current) return;
        // Network failure — keep cached page if we have one.
        setPage((prev) => {
          if (!prev) {
            setError(err instanceof Error ? err.message : 'Network error');
          }
          return prev;
        });
      } finally {
        if (seq === requestSeq.current) setLoading(false);
      }
    },
    [pageId, lat, lon],
  );

  // Mount + opts change: read cache, then fetch (background if cache hit).
  useEffect(() => {
    let cancelled = false;

    (async () => {
      // Prefetched page already in state — skip cache read, fetch in background.
      let cacheHit = initialPage != null;
      try {
        if (cacheHit) {
          if (cancelled) return;
          await doFetch(true);
          return;
        }
        const raw = await AsyncStorage.getItem(cacheKey(pageId));
        if (raw && !cancelled) {
          const parsed = JSON.parse(raw) as CacheEnvelope;
          if (parsed?.schemaVersion === CACHE_SCHEMA_VERSION && parsed.page) {
            const sanitised = sanitizePage(parsed.page);
            if (sanitised) {
              setPage(sanitised);
              memPageCache.set(pageId, sanitised);
              cacheHit = true;
              if (parsed.etag) {
                etagRef.current = parsed.etag;
                memEtagCache.set(pageId, parsed.etag);
              }
            }
          } else {
            // Schema bump — drop stale cache.
            await AsyncStorage.removeItem(cacheKey(pageId)).catch(() => {});
          }
        }
      } catch {
        // Ignore cache read errors.
      }

      if (cancelled) return;
      // If we have a cache hit, fetch in background (don't flip loading);
      // otherwise treat this as a foreground fetch.
      await doFetch(cacheHit);
    })();

    return () => {
      cancelled = true;
    };
  }, [pageId, doFetch, initialPage]);

  const refetch = useCallback(async () => {
    await doFetch(false);
  }, [doFetch]);

  const fetchSection = useCallback(
    async (
      sectionId: string,
      cursor?:   string,
    ): Promise<SduiLazySectionResponse | null> => {
      const url = buildSectionUrl(
        pageId,
        sectionId,
        cursor,
        { lat, lon },
        page?.snapshot_at,
      );

      const baseHeaders: Record<string, string> = {
        'X-Client-Version': getAppVersion(),
        'X-Screen-Width':   getScreenWidth(),
        'Accept-Language':  getLocale(),
      };
      if (etagRef.current) baseHeaders['If-None-Match'] = etagRef.current;

      // Initial attempt + 2 retries with backoff.
      const delays = [0, ...LAZY_RETRY_DELAYS_MS];
      let lastErr: unknown = null;

      for (let i = 0; i < delays.length; i++) {
        if (delays[i] > 0) {
          await new Promise((r) => setTimeout(r, delays[i]));
        }
        try {
          const res = await fetchWithTimeout(
            url,
            { method: 'GET', headers: baseHeaders },
            LAZY_FETCH_TIMEOUT_MS,
          );
          if (!res.ok) {
            lastErr = new Error(`status ${res.status}`);
            continue;
          }
          const json = (await res.json()) as SduiLazySectionResponse;
          return json;
        } catch (err) {
          lastErr = err;
        }
      }

      logEvent('sdui_lazy_section_failed', {
        section_id: sectionId,
        error:      lastErr instanceof Error ? lastErr.message : String(lastErr),
      });
      return null;
    },
    [pageId, lat, lon, page?.snapshot_at],
  );

  return { page, loading, error, refetch, fetchSection };
}
