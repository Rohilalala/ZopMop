// @ts-nocheck
//
// Unit tests for the SDUI action allowlist (audit C-7 / E1D-2 / A2-1).
// Uses jest-style describe/it/expect API. zopmop-app does not yet have
// jest configured (see package.json scripts) — these tests are
// runnable as soon as jest lands. ts-nocheck keeps tsc --noEmit clean
// in the meantime.
//
// What's covered:
//   - navigate     : allowlisted screen ✓ / unknown screen ✗
//   - navigate     : suspicious param key ✗ / nested object param ✗
//   - bottom_sheet : primitive props ✓ / nested object props ✗
//   - toast        : ok ✓ / >200-char ✗ / unknown variant ✗
//   - api_call     : sdui prefix ✓ / off-prefix ✗ / wrong method ✗
//   - deep_link    : https ✓ / tel ✗ / mailto ✗ / javascript ✗ / upi ✗
//   - load_more    : sdui-prefix endpoint ✓ / off-prefix ✗

import {
	isAllowedDeepLinkUrl,
	isAllowedEndpoint,
	sanitizeAction,
	sanitizeParams,
} from '../safeguards';

describe('sanitizeParams', () => {
	it('returns {} for undefined / null', () => {
		expect(sanitizeParams(undefined)).toEqual({});
		expect(sanitizeParams(null)).toEqual({});
	});

	it('accepts primitive values', () => {
		expect(sanitizeParams({ a: 'x', b: 1, c: true })).toEqual({
			a: 'x', b: 1, c: true,
		});
	});

	it('rejects nested objects (smuggling vehicle)', () => {
		expect(sanitizeParams({ a: { url: 'evil:' } })).toBeNull();
		expect(sanitizeParams({ a: ['x'] })).toBeNull();
	});

	it('rejects suspicious keys (case-insensitive)', () => {
		expect(sanitizeParams({ url: 'https://x' })).toBeNull();
		expect(sanitizeParams({ HREF: 'x' })).toBeNull();
		expect(sanitizeParams({ Endpoint: 'x' })).toBeNull();
		expect(sanitizeParams({ src: 'x' })).toBeNull();
		expect(sanitizeParams({ ACTION: 'x' })).toBeNull();
	});
});

describe('isAllowedDeepLinkUrl', () => {
	it('allows https', () => {
		expect(isAllowedDeepLinkUrl('https://zopmop.com/offers/x')).toBe(true);
	});

	it('blocks tel / mailto / upi / javascript / data / file', () => {
		expect(isAllowedDeepLinkUrl('tel:+911234567890')).toBe(false);
		expect(isAllowedDeepLinkUrl('mailto:a@b.com')).toBe(false);
		expect(isAllowedDeepLinkUrl('upi://pay?pa=x@y')).toBe(false);
		expect(isAllowedDeepLinkUrl('javascript:alert(1)')).toBe(false);
		expect(isAllowedDeepLinkUrl('data:text/html,<script>')).toBe(false);
		expect(isAllowedDeepLinkUrl('file:///etc/passwd')).toBe(false);
	});

	it('blocks malformed URLs', () => {
		expect(isAllowedDeepLinkUrl('not a url')).toBe(false);
		expect(isAllowedDeepLinkUrl('')).toBe(false);
	});
});

describe('isAllowedEndpoint', () => {
	it('allows /api/v1/sdui/ prefix', () => {
		expect(isAllowedEndpoint('/api/v1/sdui/track')).toBe(true);
		expect(isAllowedEndpoint('/api/v1/sdui/section/x/load')).toBe(true);
	});

	it('rejects everything outside the prefix', () => {
		expect(isAllowedEndpoint('/api/v1/users/me')).toBe(false);
		expect(isAllowedEndpoint('/api/v1/admin/grant')).toBe(false);
		expect(isAllowedEndpoint('/api/v1/bookings/x/cancel')).toBe(false);
	});

	it('rejects mid-string smuggling (no contains, only startsWith)', () => {
		expect(isAllowedEndpoint('/api/v1/users/me?next=/api/v1/sdui/x')).toBe(false);
		expect(isAllowedEndpoint('https://evil.com/api/v1/sdui/x')).toBe(false);
	});
});

describe('sanitizeAction — navigate', () => {
	it('passes a known screen', () => {
		const out = sanitizeAction({
			trigger: 'tap', type: 'navigate', screen: 'Home', params: { id: '1' },
		});
		expect(out).toEqual({
			trigger: 'tap', type: 'navigate', screen: 'Home', params: { id: '1' },
		});
	});

	it('rejects an unknown screen', () => {
		expect(sanitizeAction({
			trigger: 'tap', type: 'navigate', screen: 'AdminDashboard',
		})).toBeNull();
	});

	it('rejects a suspicious params key', () => {
		expect(sanitizeAction({
			trigger: 'tap', type: 'navigate', screen: 'Payment',
			params: { url: 'evil.com' },
		})).toBeNull();
	});

	it('rejects nested object params', () => {
		expect(sanitizeAction({
			trigger: 'tap', type: 'navigate', screen: 'Home',
			params: { sub: { url: 'evil:' } },
		})).toBeNull();
	});
});

describe('sanitizeAction — bottom_sheet', () => {
	it('passes primitive props', () => {
		expect(sanitizeAction({
			trigger: 'tap', type: 'bottom_sheet', sheet_id: 'promo', props: { id: 1 },
		})).not.toBeNull();
	});

	it('rejects nested-object props', () => {
		expect(sanitizeAction({
			trigger: 'tap', type: 'bottom_sheet', sheet_id: 'x',
			props: { nested: { x: 1 } },
		})).toBeNull();
	});
});

describe('sanitizeAction — toast', () => {
	it('passes a normal message', () => {
		expect(sanitizeAction({
			trigger: 'tap', type: 'toast', message: 'Saved.', variant: 'success',
		})).not.toBeNull();
	});

	it('caps message length', () => {
		expect(sanitizeAction({
			trigger: 'tap', type: 'toast', message: 'x'.repeat(1000),
		})).toBeNull();
	});

	it('rejects unknown variant', () => {
		expect(sanitizeAction({
			trigger: 'tap', type: 'toast', message: 'ok', variant: 'critical',
		})).toBeNull();
	});
});

describe('sanitizeAction — api_call', () => {
	it('passes /api/v1/sdui/ + POST', () => {
		expect(sanitizeAction({
			trigger: 'tap', type: 'api_call',
			endpoint: '/api/v1/sdui/track', method: 'POST',
		})).not.toBeNull();
	});

	it('rejects off-prefix endpoint', () => {
		expect(sanitizeAction({
			trigger: 'tap', type: 'api_call',
			endpoint: '/api/v1/users/me', method: 'POST',
		})).toBeNull();
	});

	it('rejects GET method (only POST/DELETE allowed)', () => {
		expect(sanitizeAction({
			trigger: 'tap', type: 'api_call',
			endpoint: '/api/v1/sdui/track', method: 'GET',
		})).toBeNull();
	});
});

describe('sanitizeAction — deep_link', () => {
	it('passes https', () => {
		expect(sanitizeAction({
			trigger: 'tap', type: 'deep_link', url: 'https://zopmop.com/x',
		})).not.toBeNull();
	});

	it('rejects tel', () => {
		expect(sanitizeAction({
			trigger: 'tap', type: 'deep_link', url: 'tel:+911234567890',
		})).toBeNull();
	});

	it('rejects javascript', () => {
		expect(sanitizeAction({
			trigger: 'tap', type: 'deep_link', url: 'javascript:alert(1)',
		})).toBeNull();
	});

	it('rejects upi', () => {
		expect(sanitizeAction({
			trigger: 'tap', type: 'deep_link', url: 'upi://pay?pa=x@y',
		})).toBeNull();
	});
});

describe('sanitizeAction — load_more', () => {
	it('passes sdui-prefix endpoint', () => {
		expect(sanitizeAction({
			trigger: 'auto', type: 'load_more',
			section_id: 's1', cursor: 'c1', endpoint: '/api/v1/sdui/section/s1/load',
		})).not.toBeNull();
	});

	it('rejects off-prefix endpoint', () => {
		expect(sanitizeAction({
			trigger: 'auto', type: 'load_more',
			section_id: 's1', cursor: 'c1', endpoint: '/api/v1/admin/dump',
		})).toBeNull();
	});
});

describe('sanitizeAction — frame', () => {
	it('rejects non-objects', () => {
		expect(sanitizeAction(null)).toBeNull();
		expect(sanitizeAction('navigate')).toBeNull();
		expect(sanitizeAction(42)).toBeNull();
	});

	it('rejects unknown trigger', () => {
		expect(sanitizeAction({
			trigger: 'hover', type: 'navigate', screen: 'Home',
		})).toBeNull();
	});

	it('rejects unknown type', () => {
		expect(sanitizeAction({
			trigger: 'tap', type: 'eval_js', payload: 'alert(1)',
		})).toBeNull();
	});
});
