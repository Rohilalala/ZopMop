// SDUI safeguards — sanitise server-supplied page configs before rendering.
// Server is partially trusted; we still whitelist layout keys and validate
// minimum shape so bad/old configs cannot crash the app.

import {
	ALLOWED_DEEP_LINK_SCHEMES,
	ALLOWED_ENDPOINT_PREFIX,
	ALLOWED_SCREENS,
} from './allowlist';
import type { SduiAction, SduiLayout, SduiPage, SduiSection } from './types';

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

  // Run every server-supplied action through the allowlist sanitiser.
  // Anything that fails (unknown screen, javascript: deep link, off-prefix
  // endpoint, smuggled URL in params, …) gets dropped silently. Defense
  // in depth: ActionHandler re-validates at execute time too, so even a
  // section that bypassed this check cannot fire a forbidden action.
  normalised.actions = Array.isArray(section.actions)
    ? (section.actions
        .map((a) => sanitizeAction(a))
        .filter((a): a is SduiAction => a !== null))
    : [];

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

// ── Action allowlist (audit C-7 / E1D-2 / A2-1) ──────────────────────────────

// Param keys that smell like URL/action smuggling. SDUI screens never need
// to receive a "url" or "endpoint" via params — those would be the attacker
// re-injecting a malicious target through the params side channel.
const SUSPICIOUS_PARAM_KEYS = new Set<string>([
	'url',
	'href',
	'endpoint',
	'src',
	'action',
]);

const ALLOWED_PARAM_VALUE_TYPES = new Set<string>([
	'string',
	'number',
	'boolean',
]);

const TOAST_MAX_MESSAGE_LENGTH = 200;
const TOAST_VARIANTS = new Set<string>(['info', 'success', 'error']);

/**
 * sanitizeParams enforces a primitives-only contract on every action's
 * caller-supplied params/props/body bag. Returns:
 *   - {}                    when the input is undefined / null
 *   - { … primitives … }    when every value is string|number|boolean and
 *                           no key collides with a SUSPICIOUS_PARAM_KEYS
 *                           entry (case-insensitive)
 *   - null                  on any violation — caller must drop the action
 *
 * Nested objects are rejected because they're the canonical smuggling
 * vehicle (e.g. { sub: { url: 'evil:…' } }). If a future legitimate action
 * needs structured params, allowlist its specific shape rather than relaxing
 * this helper.
 */
export function sanitizeParams(
	params: unknown,
): Record<string, string | number | boolean> | null {
	if (params === undefined || params === null) return {};
	if (!isObject(params)) return null;
	const out: Record<string, string | number | boolean> = {};
	for (const [key, value] of Object.entries(params)) {
		if (SUSPICIOUS_PARAM_KEYS.has(key.toLowerCase())) return null;
		if (!ALLOWED_PARAM_VALUE_TYPES.has(typeof value)) return null;
		out[key] = value as string | number | boolean;
	}
	return out;
}

/**
 * isAllowedDeepLinkUrl returns true iff `url` parses cleanly and its scheme
 * is on the (currently https-only) allowlist. Any parse error or off-list
 * scheme returns false. Hostname is intentionally NOT filtered — the OS
 * browser handles https targets safely; a domain-level allowlist would
 * break legitimate offer/promo links to partner sites.
 */
export function isAllowedDeepLinkUrl(url: string): boolean {
	try {
		const parsed = new URL(url);
		const scheme = parsed.protocol.replace(':', '').toLowerCase();
		return ALLOWED_DEEP_LINK_SCHEMES.has(scheme);
	} catch {
		return false;
	}
}

/**
 * isAllowedEndpoint requires a startsWith match on the SDUI prefix.
 * "Contains" or regex matches would let an attacker prepend a different
 * legitimate path then ../../-traverse — startsWith is the only safe check.
 */
export function isAllowedEndpoint(endpoint: string): boolean {
	return endpoint.startsWith(ALLOWED_ENDPOINT_PREFIX);
}

/**
 * sanitizeAction validates a single SduiAction against the client-side
 * allowlist. Returns the well-typed action on success; null on any rule
 * violation. Used by safeSection at parse time AND by ActionHandler at
 * dispatch time (defense in depth — if the parse layer is ever bypassed
 * by lazy section loads, the dispatcher still refuses to fire a bad
 * action).
 *
 * Closes audit C-7 / E1D-2 / A2-1: server-pushed action.screen,
 * action.url, action.endpoint values can no longer reach navigation,
 * Linking.openURL, or apiFetch without first matching the allowlist.
 */
export function sanitizeAction(action: unknown): SduiAction | null {
	if (!isObject(action)) return null;
	const a = action as Record<string, unknown>;
	const trigger = a.trigger;
	if (trigger !== 'tap' && trigger !== 'long_press' && trigger !== 'auto') {
		return null;
	}

	switch (a.type) {
		case 'navigate': {
			if (typeof a.screen !== 'string') return null;
			if (!ALLOWED_SCREENS.has(a.screen)) return null;
			const params = sanitizeParams(a.params);
			if (params === null) return null;
			return { trigger, type: 'navigate', screen: a.screen, params };
		}

		case 'bottom_sheet': {
			if (typeof a.sheet_id !== 'string') return null;
			// sheet_id allowlist deliberately deferred — separate PR. Props are
			// still primitive-only via sanitizeParams.
			const props = sanitizeParams(a.props);
			if (props === null) return null;
			return { trigger, type: 'bottom_sheet', sheet_id: a.sheet_id, props };
		}

		case 'toast': {
			if (typeof a.message !== 'string') return null;
			if (a.message.length > TOAST_MAX_MESSAGE_LENGTH) return null;
			const variant = a.variant;
			if (variant !== undefined && (typeof variant !== 'string' || !TOAST_VARIANTS.has(variant))) {
				return null;
			}
			return {
				trigger,
				type: 'toast',
				message: a.message,
				variant: variant as 'info' | 'success' | 'error' | undefined,
			};
		}

		case 'api_call': {
			if (typeof a.endpoint !== 'string') return null;
			if (!isAllowedEndpoint(a.endpoint)) return null;
			if (a.method !== 'POST' && a.method !== 'DELETE') return null;
			const body = sanitizeParams(a.body);
			if (body === null) return null;
			return {
				trigger,
				type: 'api_call',
				endpoint: a.endpoint,
				method: a.method,
				body,
			};
		}

		case 'deep_link': {
			if (typeof a.url !== 'string') return null;
			if (!isAllowedDeepLinkUrl(a.url)) return null;
			return { trigger, type: 'deep_link', url: a.url };
		}

		case 'load_more': {
			if (typeof a.section_id !== 'string') return null;
			if (typeof a.cursor !== 'string') return null;
			if (typeof a.endpoint !== 'string') return null;
			if (!isAllowedEndpoint(a.endpoint)) return null;
			return {
				trigger,
				type: 'load_more',
				section_id: a.section_id,
				cursor: a.cursor,
				endpoint: a.endpoint,
			};
		}

		default:
			return null;
	}
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
