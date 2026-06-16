// AppIcon — platform-native icon.
//   iOS     → real SF Symbol (expo-symbols / UIImage SF Symbol).
//   Android → the existing Feather icon set, unchanged.
//
// Callers keep passing Feather names (drop-in for <Feather/>); on iOS the name
// is mapped to its SF Symbol equivalent. Unmapped names fall back to Feather on
// both platforms, so this is always safe to use.

import React from 'react';
import { Platform } from 'react-native';
import { Feather } from '@expo/vector-icons';
import { SymbolView } from 'expo-symbols';
import type { SFSymbol } from 'sf-symbols-typescript';

type FeatherName = React.ComponentProps<typeof Feather>['name'];

// Feather name → SF Symbol. Covers every icon used on the Profile screen.
const SF_MAP: Partial<Record<FeatherName, SFSymbol>> = {
  'help-circle':   'questionmark.circle',
  'bell':          'bell',
  'x':             'xmark',
  'x-circle':      'xmark.circle',
  'users':         'person.2',
  'user':          'person',
  'tag':           'tag',
  'shield':        'checkmark.shield',
  'phone':         'phone',
  'moon':          'moon',
  'map-pin':       'mappin',
  'log-out':       'rectangle.portrait.and.arrow.right',
  'lock':          'lock',
  'info':          'info.circle',
  'home':          'house',
  'gift':          'gift',
  'file-text':     'doc.text',
  'credit-card':   'creditcard',
  'chevron-right': 'chevron.right',
  'chevron-left':  'chevron.left',
  'calendar':      'calendar',
};

type Props = { name: FeatherName; size?: number; color: string };

export function AppIcon({ name, size = 22, color }: Props) {
  if (Platform.OS === 'ios') {
    const sf = SF_MAP[name];
    if (sf) {
      return <SymbolView name={sf} size={size} tintColor={color} weight="medium" />;
    }
  }
  return <Feather name={name} size={size} color={color} />;
}
