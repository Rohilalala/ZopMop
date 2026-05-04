import AsyncStorage from '@react-native-async-storage/async-storage';
import { apiFetch } from '../api/client';
import { BASE_URL } from '../api/config';

export const LOCATION_PING_QUEUE_KEY = '@zopmop/location-ping-queue';

export type LocationPing = {
  lat: number;
  lng: number;
  timestamp: number;
};

async function readQueue(): Promise<LocationPing[]> {
  const raw = await AsyncStorage.getItem(LOCATION_PING_QUEUE_KEY);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

async function writeQueue(queue: LocationPing[]): Promise<void> {
  await AsyncStorage.setItem(LOCATION_PING_QUEUE_KEY, JSON.stringify(queue));
}

export async function enqueueLocationPing(ping: LocationPing): Promise<void> {
  const queue = await readQueue();
  queue.push(ping);
  await writeQueue(queue);
}

export async function flushLocationPingQueue(token: string): Promise<void> {
  if (!token) return;
  const queue = await readQueue();
  if (queue.length === 0) return;

  let i = 0;
  for (; i < queue.length; i++) {
    const ping = queue[i];
    try {
      const res = await apiFetch(`${BASE_URL}/helpers/me/location`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
        body: JSON.stringify({ lat: ping.lat, lng: ping.lng, timestamp: ping.timestamp }),
      });
      if (!res.ok) break;
    } catch {
      break;
    }
  }

  if (i >= queue.length) {
    await AsyncStorage.removeItem(LOCATION_PING_QUEUE_KEY);
  } else {
    await writeQueue(queue.slice(i));
  }
}
