import AsyncStorage from '@react-native-async-storage/async-storage';

const KEY = 'zopmop.lastKnownLocation';

export interface LastKnownLocation {
  lat: number;
  lon: number;
  name?: string;
  addressId?: string;
  savedAt: number;
}

export async function readLastKnownLocation(): Promise<LastKnownLocation | null> {
  try {
    const raw = await AsyncStorage.getItem(KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as LastKnownLocation;
    if (typeof parsed?.lat !== 'number' || typeof parsed?.lon !== 'number') return null;
    return parsed;
  } catch {
    return null;
  }
}

export async function writeLastKnownLocation(loc: Omit<LastKnownLocation, 'savedAt'>): Promise<void> {
  try {
    await AsyncStorage.setItem(KEY, JSON.stringify({ ...loc, savedAt: Date.now() }));
  } catch {}
}
