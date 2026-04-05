// Push notifications are disabled for local development builds (free Apple developer
// account does not support the aps-environment entitlement).
// Re-enable by restoring expo-notifications integration and a paid provisioning profile.

export function usePushNotifications() {
  return { expoPushToken: undefined, notification: undefined };
}
