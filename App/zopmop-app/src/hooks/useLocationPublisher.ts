import { useEffect } from 'react';
import * as Location from 'expo-location';

import { useAuth } from '../context/AuthContext';
import { getLocationWsUrl } from '../api/matching';

// useLocationPublisher streams the pro's live GPS to the backend
// /location/ws WebSocket while `active` is true (i.e. the pro is en-route or
// working a job). The backend writes each fix to Redis GEO + Postgres
// (helpers.current_lat/lng/last_location_at), which feeds the customer's
// TrackLive map and the CRM live-pins map.
//
// Without this hook the pro app never opened a location socket during a job:
// the only GPS that ever reached the backend was the one-shot en-route/arrived
// stamps, so the customer map showed the pro frozen at their go-online
// position and the CRM map aged every pro off after 90s.
//
// Auth model mirrors TrackLiveScreen / getBookingTrackingWsUrl: the token is
// NOT in the URL — we send {"type":"auth","token":"<JWT>"} as the first
// message after the socket opens.
const POLL_INTERVAL_MS = 10_000;
const POLL_DISTANCE_M = 25;

export function useLocationPublisher(active: boolean) {
  const { token } = useAuth();

  useEffect(() => {
    if (!active || !token || token === '__guest__') return;

    let alive = true;
    let ws: WebSocket | null = null;
    let sub: Location.LocationSubscription | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let backoffMs = 1000;
    let authed = false;
    let lastCoord: { lat: number; lng: number } | null = null;

    const sendCoord = (lat: number, lng: number) => {
      lastCoord = { lat, lng };
      if (ws && authed && ws.readyState === WebSocket.OPEN) {
        try {
          ws.send(JSON.stringify({ lat, lng }));
        } catch {}
      }
    };

    const startWatch = async () => {
      try {
        const perm = await Location.getForegroundPermissionsAsync();
        if (perm.status !== 'granted' || !alive) return;
        sub = await Location.watchPositionAsync(
          {
            accuracy: Location.Accuracy.Balanced,
            timeInterval: POLL_INTERVAL_MS,
            distanceInterval: POLL_DISTANCE_M,
          },
          (pos) => sendCoord(pos.coords.latitude, pos.coords.longitude),
        );
      } catch {
        /* permission revoked / sensor error — leave the stream idle */
      }
    };

    const connect = () => {
      if (!alive) return;
      try {
        ws = new WebSocket(getLocationWsUrl());
      } catch {
        return; // bad URL (e.g. http:// in production)
      }

      ws.onopen = () => {
        try {
          ws?.send(JSON.stringify({ type: 'auth', token }));
        } catch {}
      };

      ws.onmessage = (ev) => {
        try {
          const raw = typeof ev.data === 'string' ? ev.data : '';
          const msg = JSON.parse(raw);
          if (msg && msg.status === 'authenticated') {
            authed = true;
            backoffMs = 1000;
            // Flush the most recent fix immediately so the map updates
            // without waiting for the next watch callback.
            if (lastCoord) sendCoord(lastCoord.lat, lastCoord.lng);
          }
        } catch {}
      };

      const scheduleReconnect = () => {
        authed = false;
        if (!alive) return;
        if (reconnectTimer) clearTimeout(reconnectTimer);
        reconnectTimer = setTimeout(connect, backoffMs);
        backoffMs = Math.min(backoffMs * 2, 15000);
      };

      ws.onerror = scheduleReconnect;
      ws.onclose = scheduleReconnect;
    };

    startWatch();
    connect();

    return () => {
      alive = false;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      if (sub) {
        try { sub.remove(); } catch {}
      }
      if (ws) {
        ws.onopen = ws.onmessage = ws.onerror = ws.onclose = null;
        try { ws.close(); } catch {}
      }
    };
  }, [active, token]);
}
