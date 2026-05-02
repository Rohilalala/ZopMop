// ZopSleeping — thin wrapper around `assets/zop/zop-sleeping.svg`. The SVG
// itself bakes in the +10° clockwise tilt on the Zop group while keeping the
// Z's upright, so the component is just a sized renderer.

import React from 'react';
import ZopSleepingSvg from '../../../assets/zop/zop-sleeping.svg';

type Props = { size?: number };

export function ZopSleeping({ size = 200 }: Props) {
  return <ZopSleepingSvg width={size} height={size} />;
}
