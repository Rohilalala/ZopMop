// Maps a service to its 3D PNG render under `assets/Service icons/`. Filenames
// use lowercase + hyphens (no spaces / no caps) — Metro's static asset registry
// silently drops requires that contain spaces or mixed case, so do not rename
// these without re-checking on a clean Metro cache.
//
// Returns undefined when no asset exists for the service — caller falls back
// to the emoji glyph.

import type { ImageSourcePropType } from 'react-native';

const ASSETS: Record<string, ImageSourcePropType> = {
  'mopping-and-sweeping': require('../../../assets/Service icons/mopping-and-sweeping.png'),
  'bathroom-cleaning':    require('../../../assets/Service icons/bathroom-cleaning.png'),
  'utensils':             require('../../../assets/Service icons/utensils.png'),
  'kitchen-prep':         require('../../../assets/Service icons/kitchen-prep.png'),
  'window-cleaning':      require('../../../assets/Service icons/window-cleaning.png'),
  'car-cleaning':         require('../../../assets/Service icons/car-cleaning.png'),
  'balcony':              require('../../../assets/Service icons/balcony.png'),
  'plant-care':           require('../../../assets/Service icons/plant-care.png'),
};

// Fixed UUIDs from migration 015_seed_service_categories.sql.
const ID_TO_KEY: Record<string, string> = {
  'a1000000-0000-0000-0000-000000000001': 'mopping-and-sweeping',
  'a1000000-0000-0000-0000-000000000002': 'bathroom-cleaning',
  'a1000000-0000-0000-0000-000000000003': 'utensils',
  'a1000000-0000-0000-0000-000000000005': 'kitchen-prep',
  'a1000000-0000-0000-0000-000000000007': 'window-cleaning',
};

function slug(name: string): string {
  return name
    .toLowerCase()
    .replace(/&/g, 'and')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

const NAME_ALIASES: Record<string, string> = {
  'quick-clean':            'mopping-and-sweeping',
  'deep-clean':             'mopping-and-sweeping',
  'sweeping-and-mopping':   'mopping-and-sweeping',
  'mopping':                'mopping-and-sweeping',
  'bathroom':               'bathroom-cleaning',
  'dishes':                 'utensils',
  'kitchen':                'kitchen-prep',
};

export function serviceIcon(opts: {
  id?: string;
  name?: string;
}): ImageSourcePropType | undefined {
  if (opts.id && ID_TO_KEY[opts.id]) {
    return ASSETS[ID_TO_KEY[opts.id]];
  }
  if (opts.name) {
    const s = slug(opts.name);
    if (ASSETS[s]) return ASSETS[s];
    const aliased = NAME_ALIASES[s];
    if (aliased && ASSETS[aliased]) return ASSETS[aliased];
  }
  return undefined;
}
