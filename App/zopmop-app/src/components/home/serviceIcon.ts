// Maps a service to its 3D PNG render under `assets/Service icons/`. Filenames
// use lowercase + hyphens (no spaces / no caps) — Metro's static asset registry
// silently drops requires that contain spaces or mixed case, so do not rename
// these without re-checking on a clean Metro cache.
//
// Returns undefined when no asset exists for the service — caller falls back
// to the emoji glyph.

import type { ImageSourcePropType } from 'react-native';

const ASSETS: Record<string, ImageSourcePropType> = {
  'bathroom-cleaning':     require('../../../assets/Service icons/bathroom-cleaning.png'),
  'utensils':              require('../../../assets/Service icons/utensils.png'),
  'mopping-and-sweeping':  require('../../../assets/Service icons/mopping-and-sweeping.png'),
  'dusting':               require('../../../assets/Service icons/dusting.png'),
  'packing':               require('../../../assets/Service icons/packing.png'),
  'unpacking':             require('../../../assets/Service icons/unpacking.png'),
  'ironing-and-folding':   require('../../../assets/Service icons/ironing-and-folding.png'),
  'laundry':               require('../../../assets/Service icons/laundry.png'),
  'kitchen-prep':          require('../../../assets/Service icons/kitchen-prep.png'),
  'window-cleaning':       require('../../../assets/Service icons/window-cleaning.png'),
  'kitchen-cleaning':      require('../../../assets/Service icons/kitchen-cleaning.png'),
  'balcony':               require('../../../assets/Service icons/balcony.png'),
  'fan-cleaning':          require('../../../assets/Service icons/fan-cleaning.png'),
  'fridge-cleaning':       require('../../../assets/Service icons/fridge-cleaning.png'),
  'wardrobe-organization': require('../../../assets/Service icons/wardrobe-organization.png'),
  'plant-care':            require('../../../assets/Service icons/plant-care.png'),
  'pre-post-party':        require('../../../assets/Service icons/pre-post-party.png'),
  // car-cleaning: service deactivated in migration 112; asset kept on disk but unmapped.
  'car-cleaning':          require('../../../assets/Service icons/car-cleaning.png'),
};

// Fixed UUIDs from migrations 015/017 (seeds) + 112 (catalog reconciliation to 17).
const ID_TO_KEY: Record<string, string> = {
  'a1000000-0000-0000-0000-000000000002': 'bathroom-cleaning',
  'a1000000-0000-0000-0000-000000000003': 'utensils',
  'a1000000-0000-0000-0000-000000000001': 'mopping-and-sweeping',
  'a1000000-0000-0000-0000-000000000004': 'dusting',
  'a1000000-0000-0000-0000-000000000019': 'packing',
  'a1000000-0000-0000-0000-000000000020': 'unpacking',
  'a1000000-0000-0000-0000-000000000009': 'ironing-and-folding',
  'a1000000-0000-0000-0000-000000000006': 'laundry',
  'a1000000-0000-0000-0000-000000000005': 'kitchen-prep',
  'a1000000-0000-0000-0000-000000000007': 'window-cleaning',
  'a1000000-0000-0000-0000-000000000012': 'kitchen-cleaning',
  'a1000000-0000-0000-0000-000000000010': 'balcony',
  'a1000000-0000-0000-0000-000000000021': 'fan-cleaning',
  'a1000000-0000-0000-0000-000000000008': 'fridge-cleaning',
  'a1000000-0000-0000-0000-000000000014': 'wardrobe-organization',
  'a1000000-0000-0000-0000-000000000018': 'plant-care',
  'a1000000-0000-0000-0000-000000000022': 'pre-post-party',
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
  'utensil-washing':        'utensils',
  'balcony-cleaning':       'balcony',
  'party-cleanup': 'pre-post-party',
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
