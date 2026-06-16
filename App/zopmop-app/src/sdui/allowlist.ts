// SDUI client-side allowlists. Closes audit C-7 / E1D-2 / A2-1: the
// server-trusted SDUI action surface is now constrained to known-safe
// targets so a malicious or compromised CRM admin cannot push arbitrary
// deep links, navigation, or backend calls to every device.
//
// AUTHORITATIVE SOURCE for ALLOWED_SCREENS: src/navigation/MainNavigator.tsx.
// When adding a new <Stack.Screen name="X"> there, ALSO add "X" here.
// Failure to add → SDUI navigation actions targeting that screen will
// be silently dropped (safe default — see safeguards.sanitizeAction).
//
// TODO (follow-up): jest test asserting this Set matches the navigator's
// registered screens. Not in this PR — zopmop-app has no jest config yet.

import { ROOMIES_ENABLED } from '../config/features';

export const ALLOWED_SCREENS = new Set<string>([
	// Tab roots
	'Tabs', 'Home', 'Bookings', 'Cart', 'Profile', 'Wallet',
	// Customer flows
	'ActiveBooking', 'Addresses', 'AllServices', 'BookingConfirmed',
	'BookingRate', 'Chat', 'HelpSupport', 'HiZop', 'InstantMatching',
	'Location', 'NameEntry', 'NotServiceable',
	'Offers', 'OTPVerification', 'Payment', 'PhoneEntry', 'ReferralEarn',
	'ServiceAbout', 'Tip', 'TrackLive', 'Welcome',
	'YourExperts', 'ZopIntro',
	// Pro flows (also gated per-screen via useProRoleGate from C-9).
	// Phase 10: ProActive/ProMatched/ProScheduledInvite retired —
	// replaced by JobDetail. JobOffer removed under unified-slot-dispatch
	// (offer/accept flow deleted; jobs are force-assigned to the roster).
	'ProDashboard', 'ProDeclareLeave', 'ProLeaveHistory',
	'ProOnboarding', 'ProProfile', 'JobDetail', 'JobOffer',
	// Roomies (feature-gated off for launch — routes unregistered while
	// ROOMIES_ENABLED is false; re-add automatically via the spread).
	...(ROOMIES_ENABLED
		? ['ManageHousehold', 'RoomiesCodeShare', 'RoomiesJoin', 'RoomiesSetup', 'RoomiesWelcome']
		: []),
]);

// SDUI deep_link actions are restricted to https. First-party tel: and
// mailto: come from app code with hardcoded values, not SDUI — server
// has no legitimate need to push tel/mailto to a client. upi/intent/
// data/file/javascript/zopmop and any custom scheme are blocked.
export const ALLOWED_DEEP_LINK_SCHEMES = new Set<string>([
	'https',
]);

// SDUI api_call and load_more actions are restricted to backend paths
// under this prefix. Anything else (e.g. /api/v1/users/me, /api/v1/admin/*)
// would ride the user's own JWT and is exactly the surface the audit
// flagged. Extend this list explicitly as new SDUI features ship.
export const ALLOWED_ENDPOINT_PREFIX = '/api/v1/sdui/';
