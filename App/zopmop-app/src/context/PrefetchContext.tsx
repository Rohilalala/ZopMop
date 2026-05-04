import React, { createContext, useContext, useEffect, useRef, useState } from 'react';
import { Dimensions, Platform } from 'react-native';
import Constants from 'expo-constants';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { BASE_URL } from '../api/config';
import { listAddresses, type ApiAddress } from '../api/addresses';
import { sanitizePage } from '../sdui/safeguards';
import type { SduiPage } from '../sdui/types';
import { readLastKnownLocation, type LastKnownLocation } from '../utils/locationCache';
import { useAuth } from './AuthContext';

interface PrefetchedHome {
  page: SduiPage | null;
  addresses: ApiAddress[] | null;
  coords: { lat: number; lon: number } | null;
  fetchedAt: number;
}

interface PrefetchContextValue {
  consumeHome: () => PrefetchedHome | null;
}

const PrefetchContext = createContext<PrefetchContextValue>({ consumeHome: () => null });

const SDUI_CACHE_KEY = 'sdui:home';
const SDUI_SCHEMA_VERSION = 4;
const PREFETCH_TIMEOUT_MS = 6000;

async function readSduiCache(): Promise<SduiPage | null> {
  try {
    const raw = await AsyncStorage.getItem(SDUI_CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { schemaVersion?: number; page?: SduiPage };
    if (parsed?.schemaVersion !== SDUI_SCHEMA_VERSION || !parsed.page) return null;
    return sanitizePage(parsed.page);
  } catch {
    return null;
  }
}

async function fetchHomePage(coords: { lat: number; lon: number }): Promise<SduiPage | null> {
  try {
    const params = new URLSearchParams({ lat: String(coords.lat), lon: String(coords.lon) });
    const url = `${BASE_URL}/sdui/page/home?${params.toString()}`;
    const headers: Record<string, string> = {
      'X-Client-Version': (Constants?.expoConfig?.version as string | undefined) ?? 'unknown',
      'X-Screen-Width':   String(Math.round(Dimensions.get('window').width)),
      'Accept-Language':  Platform.OS === 'ios' ? 'en-IN' : 'en-IN',
    };
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), PREFETCH_TIMEOUT_MS);
    try {
      const res = await fetch(url, { method: 'GET', headers, signal: ctrl.signal });
      if (!res.ok) return null;
      const json = await res.json();
      return sanitizePage(json);
    } finally {
      clearTimeout(timer);
    }
  } catch {
    return null;
  }
}

export function PrefetchProvider({ children }: { children: React.ReactNode }) {
  const { token, isAuthenticated } = useAuth();
  const [data, setData] = useState<PrefetchedHome | null>(null);
  const consumed = useRef(false);

  useEffect(() => {
    if (!isAuthenticated || token === '__guest__' || consumed.current) return;

    let cancelled = false;
    (async () => {
      const lastLoc: LastKnownLocation | null = await readLastKnownLocation();
      const coords = lastLoc ? { lat: lastLoc.lat, lon: lastLoc.lon } : null;

      // Kick off SDUI page fetch + addresses in parallel. Cache read is
      // instant; network calls race with splash animation.
      const cachedPagePromise = readSduiCache();
      const freshPagePromise  = coords ? fetchHomePage(coords) : Promise.resolve(null);
      const addressesPromise  = token
        ? listAddresses(token).catch(() => null)
        : Promise.resolve(null);

      const [cachedPage, freshPage, addresses] = await Promise.all([
        cachedPagePromise,
        freshPagePromise,
        addressesPromise,
      ]);

      if (cancelled) return;
      // Prefer fresh page; fall back to cached page; null is fine — HomeScreen
      // hook will fall through to its own first-paint path.
      setData({
        page: freshPage ?? cachedPage,
        addresses: addresses ?? null,
        coords,
        fetchedAt: Date.now(),
      });
    })();

    return () => { cancelled = true; };
  }, [isAuthenticated, token]);

  const consumeHome = (): PrefetchedHome | null => {
    if (!data || consumed.current) return null;
    consumed.current = true;
    return data;
  };

  return (
    <PrefetchContext.Provider value={{ consumeHome }}>
      {children}
    </PrefetchContext.Provider>
  );
}

export function usePrefetch(): PrefetchContextValue {
  return useContext(PrefetchContext);
}
