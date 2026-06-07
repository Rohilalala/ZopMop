// SDUI adapter for the live pill (nearby pros / ETA / rating).
//
// Availability is REAL-TIME and must never be faked: we ignore any count the
// SDUI config carries and start from a safe zero ("All our pros are busy"),
// then poll /insights/nearby for the real numbers — immediately on mount and
// every 5s after. A config can't make the app claim pros are available when
// they aren't; the worst case (no location / no data) stays "busy".

import React, { useEffect, useRef, useState } from 'react';

import { LivePill } from '../../components/home/LivePill';
import { getNearbyStats, type NearbyStats } from '../../api/insights';
import { readLastKnownLocation } from '../../utils/locationCache';
import type { LivePillData, SduiAction } from '../types';

interface Props {
  // Config data is intentionally unused — availability comes only from live
  // polling so a config can never fabricate "pros available".
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  data: LivePillData;
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  onAction: (action: SduiAction) => void;
}

const POLL_MS = 5_000;
const SAFE_ZERO: NearbyStats = { nearby_count: 0, avg_eta_min: 0, avg_rating: 0 };

export function LivePillSection(_props: Props) {
  // Safe placeholder: assume no pros until real data confirms otherwise.
  const [stats, setStats] = useState<NearbyStats>(SAFE_ZERO);
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

    // Poll immediately so the real count replaces the safe zero ASAP (no
    // 5s window where a stale/config value could show).
    tick();
    return () => {
      aliveRef.current = false;
      if (timer) clearTimeout(timer);
    };
  }, []);

  return <LivePill stats={stats} />;
}
