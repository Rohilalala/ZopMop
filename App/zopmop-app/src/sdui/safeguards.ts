// SDUI safeguards — sanitise server-supplied page configs before rendering.
// Server is partially trusted; we still whitelist layout keys and validate
// minimum shape so bad/old configs cannot crash the app.

import type { SduiLayout, SduiPage, SduiSection } from './types';

// Whitelist of SduiLayout keys. Any key not in this set is dropped — including
// `position`, `top`, `left`, `right`, `bottom`, `transform`, etc.
const ALLOWED_LAYOUT_KEYS = new Set<keyof SduiLayout>([
  'height',
  'width',
  'flex',
  'flexDirection',
  'alignItems',
  'justifyContent',
  'gap',
  'zIndex',
  'marginTop',
  'marginBottom',
  'marginHorizontal',
  'paddingHorizontal',
  'paddingVertical',
  'borderRadius',
  'overflow',
]);

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Returns a new SduiLayout containing only whitelisted keys. Anything else
 * (position, transform, top, left, etc.) is dropped silently.
 */
export function sanitizeLayout(layout: unknown): SduiLayout | undefined {
  if (!isObject(layout)) return undefined;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(layout)) {
    if (ALLOWED_LAYOUT_KEYS.has(key as keyof SduiLayout)) {
      out[key] = layout[key];
    }
  }
  return out as SduiLayout;
}

/**
 * Validates and normalises a single section. Returns null if the section is
 * unrenderable (missing id or type). Otherwise:
 *   - visible defaults to true if missing or non-boolean
 *   - actions defaults to []
 *   - layout is sanitised against the whitelist
 */
export function safeSection(section: unknown): SduiSection | null {
  if (!isObject(section)) return null;
  if (typeof section.id !== 'string' || typeof section.type !== 'string') {
    return null;
  }

  const normalised: Record<string, unknown> = { ...section };

  normalised.visible =
    typeof section.visible === 'boolean' ? section.visible : true;

  normalised.actions = Array.isArray(section.actions) ? section.actions : [];

  if (section.layout !== undefined) {
    const cleanLayout = sanitizeLayout(section.layout);
    if (cleanLayout) {
      normalised.layout = cleanLayout;
    } else {
      delete normalised.layout;
    }
  }

  return normalised as unknown as SduiSection;
}

/**
 * Validates the top-level page envelope and maps each section through
 * safeSection. Drops any section that fails validation. Returns null if the
 * page itself is unparseable.
 */
export function sanitizePage(page: unknown): SduiPage | null {
  if (!isObject(page)) return null;
  if (typeof page.page_id !== 'string') return null;
  if (typeof page.version !== 'string') return null;
  if (!Array.isArray(page.sections)) return null;

  const sections = page.sections
    .map((s) => safeSection(s))
    .filter((s): s is SduiSection => s !== null);

  return { ...(page as object), sections } as SduiPage;
}
