// SDUI adapter for the home footer block (FAQs + trust + sign-off).

import React from 'react';

import { HomeFooter } from '../../components/home/HomeFooter';
import type { FooterData, SduiAction } from '../types';

interface Props {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  data: FooterData;
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  onAction: (action: SduiAction) => void;
}

export function FooterSection(_props: Props) {
  return <HomeFooter />;
}
