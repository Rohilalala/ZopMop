// Sentry error tracking for the mobile app.
//
// Init is opt-in via SENTRY_DSN (read at build time by app.config.js and
// exposed through expo-constants `extra.sentryDsn`). If the DSN is empty
// every helper here is a no-op so dev / preview builds don't need a
// Sentry project.
//
// To enable in prod:
//   eas secret:create --scope project --name SENTRY_DSN --value <dsn-from-sentry>
//   eas secret:create --scope project --name SENTRY_ENVIRONMENT --value production
//
// PII handling:
//   - We deliberately don't set Sentry's user.email or user.username from
//     phone numbers. Use `setUser({ id: <backend user uuid> })` only.
//   - `sendDefaultPii: false` is set in init.
//   - Touch breadcrumbs from auto-capture are filtered for fields that
//     can leak address text (`beforeBreadcrumb`).

import * as Sentry from '@sentry/react-native';
import Constants from 'expo-constants';

const dsn = Constants.expoConfig?.extra?.sentryDsn as string | undefined;
const environment =
  (Constants.expoConfig?.extra?.sentryEnvironment as string | undefined) ?? 'production';
const release =
  (Constants.expoConfig?.extra?.sentryRelease as string | undefined) ?? undefined;

const isSentryConfigured = !!dsn && dsn.startsWith('https://');

if (__DEV__) {
  // eslint-disable-next-line no-console
  console.log('[Sentry] config:', {
    dsn: dsn ? 'SET' : 'NOT SET',
    environment,
    release: release ?? 'unset',
    enabled: isSentryConfigured,
  });
}

if (isSentryConfigured) {
  Sentry.init({
    dsn: dsn!,
    environment,
    release,
    enableAutoSessionTracking: true,
    sendDefaultPii: false,
    // Disable performance monitoring by default; flip when ready to spend
    // the Sentry quota on transactions.
    tracesSampleRate: 0,
    // Don't capture breadcrumb fields that might carry address text from
    // autocapture touch events. Keep navigation + lifecycle breadcrumbs.
    beforeBreadcrumb: (breadcrumb) => {
      if (breadcrumb.category === 'touch') {
        // Strip any text content from touch breadcrumbs.
        if (breadcrumb.data && 'text' in breadcrumb.data) {
          delete (breadcrumb.data as Record<string, unknown>).text;
        }
      }
      return breadcrumb;
    },
  });
}

export const sentryEnabled = isSentryConfigured;

/**
 * Wrap the root component so React render errors are captured automatically.
 * Pass-through (identity) when Sentry is disabled.
 */
export function wrapRoot<T>(Component: T): T {
  if (!isSentryConfigured) return Component;
  // Sentry.wrap returns ComponentType<P> — cast through unknown to satisfy
  // the generic in App.tsx.
  return Sentry.wrap(Component as unknown as React.ComponentType) as unknown as T;
}

/**
 * Set the currently-signed-in user. Only the backend UUID — no phone or name.
 * Call on signIn; call setUser(null) on signOut.
 */
export function setUser(userId: string | null) {
  if (!isSentryConfigured) return;
  if (userId) {
    Sentry.setUser({ id: userId });
  } else {
    Sentry.setUser(null);
  }
}

/**
 * Capture a non-fatal error. Tags are surfaced in Sentry's issue view.
 */
export function captureError(error: unknown, tags?: Record<string, string>) {
  if (!isSentryConfigured) return;
  Sentry.captureException(error, { tags });
}
