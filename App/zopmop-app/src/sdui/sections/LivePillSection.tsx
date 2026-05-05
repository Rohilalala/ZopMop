// SDUI adapter for the live pill (nearby pros / ETA / rating).
//
// The SDUI server seeds initial values; this component then polls
// /insights/nearby every 5 seconds so the pill feels live without forcing
// a full SDUI page re-resolve. Polling is paused when the screen unmounts.

import React, { useEffect, useRef, useState } from 'react';

import { LivePill } from '../../components/home/LivePill';
import { getNearbyStats, type NearbyStats } from '../../api/insights';
import { readLastKnownLocation } from '../../utils/locationCache';
import type { LivePillData, SduiAction } from '../types';

interface Props {
  data: LivePillData;
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  onAction: (action: SduiAction) => void;
}

const POLL_MS = 5_000;

export function LivePillSection({ data }: Props) {
  const [stats, setStats] = useState<NearbyStats>({
    nearby_count: data.nearby_count,
    avg_eta_min:  data.avg_eta_min,
    avg_rating:   data.avg_rating,
  });
  const aliveRef = useRef(true);

  useEffect(() => {
    aliveRef.current = true;
    let timer: ReturnType<typeof setTimeout> | null = null;

    async function tick() {
      if (!aliveRef.current) return;
      const loc = await readLastKnownLocation();
      if (!aliveRef.current) return;
      if (loc) {
        const fresh = await getNearbyStats(loc.lat, loc.lon);
        if (!aliveRef.current) return;
        setStats(fresh);
      }
      if (aliveRef.current) {
        timer = setTimeout(tick, POLL_MS);
      }
    }

    timer = setTimeout(tick, POLL_MS);
    return () => {
      aliveRef.current = false;
      if (timer) clearTimeout(timer);
    };
  }, []);

  // SDUI server occasionally pushes a fresh data prop (page re-resolve).
  // Treat that as a hint and adopt it so we don't lag behind a server
  // refresh while the next 5s tick is pending.
  useEffect(() => {
    setStats({
      nearby_count: data.nearby_count,
      avg_eta_min:  data.avg_eta_min,
      avg_rating:   data.avg_rating,
    });
  }, [data.nearby_count, data.avg_eta_min, data.avg_rating]);

  return <LivePill stats={stats} />;
}
