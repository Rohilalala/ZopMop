import { useEffect } from 'react';
import { useNavigation, CommonActions } from '@react-navigation/native';
import { useAuth } from '../context/AuthContext';

/**
 * Pro-screen role gate. Used at the top of every Pro screen component.
 * If the authenticated user's role is not a Pro-side role (`pro` or
 * the legacy `helper`), reset the navigation stack to the customer
 * Tabs root.
 *
 * Why this exists: customer and Pro screens currently share a single
 * RN nav stack (closes audit C-9 / CH1D-1). A deep link or FCM data
 * push targeted at a Pro flow can otherwise land a customer-role user
 * on a Pro screen — at which point Pro-only actions and location
 * pinging are exposed on their behalf. This per-screen gate is the
 * defense until the stack is structurally split.
 *
 * Behaviour:
 *   - user==null     : noop (auth flow handles unauthenticated users).
 *   - role=='pro'    : noop (legitimate caller, render the screen).
 *   - role=='helper' : noop (legacy alias, still legitimate).
 *   - other          : console.warn + nav reset to 'Tabs'. Silent UX —
 *     no Alert/toast: we don't want to acknowledge an exploit attempt
 *     to the user; the redirect itself is the only signal.
 *
 * Must stay in sync with MainNavigator.tsx's `initialRouteName` gate
 * which accepts the same two roles.
 */
export function useProRoleGate(): void {
  const { user } = useAuth();
  const navigation = useNavigation();

  useEffect(() => {
    if (!user) {
      return;
    }
    if (user.role !== 'pro' && user.role !== 'helper') {
      // eslint-disable-next-line no-console
      console.warn('[role-gate] non-pro user redirected from Pro screen', {
        userRole: user.role,
      });
      navigation.dispatch(
        CommonActions.reset({
          index: 0,
          routes: [{ name: 'Tabs' as never }],
        }),
      );
    }
  }, [user, navigation]);
}
