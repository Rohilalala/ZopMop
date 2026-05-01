// SDUI adapter for the live pill (nearby pros / ETA / rating).

import React from 'react';

import { LivePill } from '../../components/home/LivePill';
import type { LivePillData, SduiAction } from '../types';

interface Props {
  data: LivePillData;
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  onAction: (action: SduiAction) => void;
}

export function LivePillSection({ data }: Props) {
  return (
    <LivePill
      stats={{
        nearby_count: data.nearby_count,
        avg_eta_min:  data.avg_eta_min,
        avg_rating:   data.avg_rating,
      }}
    />
  );
}
