// SDUI adapter for the home footer block (FAQs + trust + sign-off).

import React from 'react';

import { HomeFooter } from '../../components/home/HomeFooter';
import type { FooterData, SduiAction } from '../types';

interface Props { data: FooterData; onAction: (action: SduiAction) => void; }

export function FooterSection({ data, onAction }: Props) {
  return <HomeFooter data={data} onAction={onAction} />;
}
