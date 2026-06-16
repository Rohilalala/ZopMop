// Tracks roster jobs the pro has acknowledged ("Got it") after they arrived
// via a booking_assigned push. UI-only — no backend call. Backed by
// AsyncStorage so the acknowledgment survives app restarts.

import AsyncStorage from '@react-native-async-storage/async-storage';

const KEY = 'zopmop.acknowledgedAssignedJobs.v1';
const MAX_REMEMBERED = 200; // keep memory bounded

let cache: Set<string> | null = null;

async function load(): Promise<Set<string>> {
  if (cache) return cache;
  try {
    const raw = await AsyncStorage.getItem(KEY);
    const arr = raw ? (JSON.parse(raw) as string[]) : [];
    cache = new Set(arr);
  } catch {
    cache = new Set();
  }
  return cache;
}

async function persist(set: Set<string>) {
  if (set.size > MAX_REMEMBERED) {
    const arr = Array.from(set).slice(set.size - MAX_REMEMBERED);
    set = new Set(arr);
    cache = set;
  }
  try {
    await AsyncStorage.setItem(KEY, JSON.stringify(Array.from(set)));
  } catch {
    // best-effort
  }
}

export async function loadAcknowledgedJobs(): Promise<Set<string>> {
  return new Set(await load());
}

export async function markJobAcknowledged(bookingId: string): Promise<void> {
  const s = await load();
  s.add(bookingId);
  await persist(s);
}
