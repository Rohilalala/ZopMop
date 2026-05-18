// Minimal, dependency-free i18n. Pro side defaults to Hindi; everything
// else stays English. Switch by calling setLocale('en'); the dashboard
// language-toggle screen lands in Phase 8.
//
// Keys use dot paths: t('dashboard.greeting', { name: 'Aditya' }).
// Interpolation tokens look like {name} — replaced inline.

import { useEffect, useState } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import hi from './hi';
import en from './en';
import type { Dict } from './hi';

export type Locale = 'hi' | 'en';

const DICTS: Record<Locale, Dict> = { hi, en };
const STORAGE_KEY = 'app_locale';

let currentLocale: Locale = 'hi';
const listeners = new Set<(loc: Locale) => void>();

export function getLocale(): Locale { return currentLocale; }

export function setLocale(loc: Locale, persist: boolean = true) {
  if (loc === currentLocale) return;
  currentLocale = loc;
  if (persist) {
    AsyncStorage.setItem(STORAGE_KEY, loc).catch(() => { /* non-fatal */ });
  }
  listeners.forEach((fn) => fn(loc));
}

/**
 * Restore the user's previously chosen locale from AsyncStorage.
 * Call once on app launch *before* rendering the navigator. If no
 * value is stored, the default ('hi') stays in effect.
 */
export async function bootstrapLocale(): Promise<Locale> {
  try {
    const saved = await AsyncStorage.getItem(STORAGE_KEY);
    if (saved === 'hi' || saved === 'en') {
      currentLocale = saved;
      listeners.forEach((fn) => fn(saved));
      return saved;
    }
  } catch { /* fall through to default */ }
  return currentLocale;
}

export function onLocaleChange(fn: (loc: Locale) => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

function lookup(dict: Dict, path: string): string | undefined {
  const parts = path.split('.');
  let cur: any = dict;
  for (const p of parts) {
    if (cur == null) return undefined;
    cur = cur[p];
  }
  return typeof cur === 'string' ? cur : undefined;
}

function interpolate(s: string, vars?: Record<string, string | number>): string {
  if (!vars) return s;
  return s.replace(/\{(\w+)\}/g, (_, k) => {
    const v = vars[k];
    return v == null ? `{${k}}` : String(v);
  });
}

/**
 * Hook that re-renders the consuming component whenever the locale
 * switches. Use this at the navigator root (or any tab that needs to
 * react to a language toggle without a full reload) so `t(...)` reads
 * pick up the new dictionary.
 */
export function useLocale(): Locale {
  const [loc, setLoc] = useState<Locale>(currentLocale);
  useEffect(() => onLocaleChange((next) => setLoc(next)), []);
  return loc;
}

export function t(path: string, vars?: Record<string, string | number>): string {
  const dict = DICTS[currentLocale];
  let raw = lookup(dict, path);
  if (raw == null) {
    if (currentLocale !== 'en') raw = lookup(DICTS.en, path);
    if (raw == null) {
      if (__DEV__) console.warn(`[i18n] missing key: ${path}`);
      return path;
    }
  }
  return interpolate(raw, vars);
}
