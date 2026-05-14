import React from 'react';
import type { SvgProps } from 'react-native-svg';

import LocationPin from '../../assets/icons/location-pin.svg';
import Celebration from '../../assets/icons/celebration.svg';
import Wrench from '../../assets/icons/wrench.svg';
import RulerDistance from '../../assets/icons/ruler-distance.svg';
import MapOpen from '../../assets/icons/map-open.svg';
import Lightning from '../../assets/icons/lightning.svg';
import CheckCircle from '../../assets/icons/check-circle.svg';
import Walker from '../../assets/icons/walker.svg';
import FlagFinish from '../../assets/icons/flag-finish.svg';
import StarFilled from '../../assets/icons/star-filled.svg';
import Coins from '../../assets/icons/coins.svg';
import DotOnline from '../../assets/icons/dot-online.svg';
import DotOffline from '../../assets/icons/dot-offline.svg';
import HomePin from '../../assets/icons/home-pin.svg';

const ICONS = {
  'location-pin': LocationPin,
  'celebration': Celebration,
  'wrench': Wrench,
  'ruler-distance': RulerDistance,
  'map-open': MapOpen,
  'lightning': Lightning,
  'check-circle': CheckCircle,
  'walker': Walker,
  'flag-finish': FlagFinish,
  'star-filled': StarFilled,
  'coins': Coins,
  'dot-online': DotOnline,
  'dot-offline': DotOffline,
  'home-pin': HomePin,
} as const;

export type SvgIconName = keyof typeof ICONS;

interface Props extends Omit<SvgProps, 'color'> {
  name: SvgIconName;
  size?: number;
  color?: string;
}

export default function SvgIcon({ name, size = 24, color = 'currentColor', ...rest }: Props) {
  const Icon = ICONS[name] as React.FC<SvgProps>;
  return <Icon width={size} height={size} color={color} {...rest} />;
}
