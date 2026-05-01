// SDUI adapter for the "Your usuals" horizontal row. Wraps UsualsRow and maps
// service taps into a navigate action handled by the renderer.

import React, { useCallback } from 'react';

import { UsualsRow } from '../../components/home/UsualsRow';
import type { ApiService } from '../../api/services';
import type { SduiAction, UsualsRowData } from '../types';

interface Props {
  data: UsualsRowData;
  onAction: (action: SduiAction) => void;
}

export function UsualsRowSection({ data, onAction }: Props) {
  const handlePress = useCallback(
    (svc: ApiService) => {
      onAction({
        trigger: 'tap',
        type:    'navigate',
        screen:  'ServiceDetail',
        params:  { serviceId: svc.id },
      });
    },
    [onAction],
  );

  if (!data.services || data.services.length === 0) return null;

  return <UsualsRow services={data.services} onPress={handlePress} />;
}
