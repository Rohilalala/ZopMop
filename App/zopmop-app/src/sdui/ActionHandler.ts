// Discriminated-union action executor. Every SDUI tap/long-press routes
// through executeAction so that:
//   1. We get a single audit point (sdui_action analytics).
//   2. The action surface stays explicit — adding a type forces this switch
//      to be updated.
// Side-effects (navigation, toasts, sheets, fetches) are injected via
// ActionContext so this module stays testable and doesn't pull in app state.

import { Linking } from 'react-native';

import { apiFetch } from '../api/client';
import { BASE_URL } from '../api/config';
import { logEvent } from '../analytics/impressionTracker';
import { analyticsContext } from '../analytics/context';
import { sanitizeAction } from './safeguards';
import type { SduiAction } from './types';

export interface ActionContext {
  // Typed `any` deliberately — every screen has a different ParamList and
  // the SDUI layer is generic over them. Caller is responsible for passing
  // a real navigation prop.
  navigation: { navigate: (screen: string, params?: Record<string, unknown>) => void };
  apiFetch?:  typeof apiFetch;
  openSheet?: (sheetId: string, props?: Record<string, unknown>) => void;
  showToast?: (message: string, variant?: 'info' | 'success' | 'error') => void;
}

export async function executeAction(
  action: SduiAction,
  ctx: ActionContext,
): Promise<void> {
  // Defense in depth: re-validate the action against the client-side
  // allowlist at execute time, even though safeSection already filters
  // server-supplied actions at parse time. Lazy section loads, cached
  // configs from older client versions, and any future call site that
  // forgets to pre-sanitise still hit this guard. Closes audit C-7 /
  // E1D-2 / A2-1.
  const safe = sanitizeAction(action);
  if (safe === null) {
    // eslint-disable-next-line no-console
    console.warn('[sdui] action blocked by allowlist', { original: action });
    logEvent('sdui_action_blocked', {
      action_type: (action as { type?: unknown })?.type ?? 'unknown',
      reason: 'allowlist',
      ...analyticsContext,
    });
    return;
  }
  action = safe;

  // Audit log first so we capture the intent even if the side-effect throws.
  logEvent('sdui_action', {
    action_type: action.type,
    trigger: action.trigger,
    ...analyticsContext,
  });

  switch (action.type) {
    case 'navigate':
      ctx.navigation.navigate(action.screen, action.params);
      return;

    case 'bottom_sheet':
      ctx.openSheet?.(action.sheet_id, action.props);
      return;

    case 'toast':
      ctx.showToast?.(action.message, action.variant ?? 'info');
      return;

    case 'api_call': {
      const fetcher = ctx.apiFetch ?? apiFetch;
      try {
        const res = await fetcher(`${BASE_URL}${action.endpoint}`, {
          method: action.method,
          body: JSON.stringify(action.body ?? {}),
          headers: { 'Content-Type': 'application/json' },
        });
        if (!res.ok) {
          ctx.showToast?.('Something went wrong. Please try again.', 'error');
        }
      } catch {
        ctx.showToast?.('Network error. Please try again.', 'error');
      }
      return;
    }

    case 'deep_link':
      try {
        await Linking.openURL(action.url);
      } catch {
        // Swallow — invalid URL or no handler shouldn't crash the renderer.
      }
      return;

    case 'load_more':
      // Pagination is owned by the section renderer / list scroll handler;
      // this helper just logs intent and no-ops.
      return;
  }
}
