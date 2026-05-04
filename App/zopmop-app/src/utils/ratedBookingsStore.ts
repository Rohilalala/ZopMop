// One-shot guard so the auto-show rating flow doesn't pester the user about
// the same booking on every Bookings tab refresh. Backed by AsyncStorage so
// the guard survives app restarts.

import AsyncStorage from '@react-native-async-storage/async-storage';

const KEY = 'zopmop.ratedBookingIds.v1';
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
  // Trim if over budget — drop oldest insert order via Set iteration.
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

export async function isBookingRated(bookingId: string): Promise<boolean> {
  const s = await load();
  return s.has(bookingId);
}

export async function markBookingRated(bookingId: string): Promise<void> {
  const s = await load();
  s.add(bookingId);
  await persist(s);
}
