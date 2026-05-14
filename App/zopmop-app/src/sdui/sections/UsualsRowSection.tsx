// SDUI adapter for the "Your usuals" horizontal row. Wraps UsualsRow and maps
// service taps into a navigate action handled by the renderer.

import React, { useCallback } from 'react';
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';

import { UsualsRow } from '../../components/home/UsualsRow';
import { haptics } from '../../utils/haptics';
import type { ApiService } from '../../api/services';
import type { MainStackParamList } from '../../types/navigation';
import type { SduiAction, UsualsRowData } from '../types';

interface Props {
  data: UsualsRowData;
  onAction: (action: SduiAction) => void;
}

export function UsualsRowSection({ data, onAction }: Props) {
  const navigation = useNavigation<NativeStackNavigationProp<MainStackParamList>>();

  const handlePress = useCallback(
    (svc: ApiService) => {
      haptics.light();
      navigation.navigate('ServiceAbout', { service: svc });
    },
    [navigation],
  );

  const handleSeeAll = useCallback(() => {
    onAction({
      trigger: 'tap',
      type:    'navigate',
      screen:  'AllServices',
    });
  }, [onAction]);

  if (!data.services || data.services.length === 0) return null;

  return (
    <UsualsRow
      services={data.services}
      onPress={handlePress}
      onSeeAll={handleSeeAll}
    />
  );
}
