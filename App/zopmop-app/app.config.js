// Dynamic config — extends app.json and injects env vars into native build.
// Expo reads this automatically. Never hardcode API keys here.
//
// SECURITY NOTE:
// - GOOGLE_MAPS_API_KEY (no EXPO_PUBLIC_ prefix) → injected into the native binary only.
//   It does NOT appear in the JavaScript bundle. Restrict this key in the Google Cloud
//   Console to the app's package name + SHA-1 fingerprint (Android) / bundle ID (iOS).
// - All geocoding and address search now use expo-location's on-device geocoder.
//   No Google Maps API key is compiled into the JS bundle.

/** @type {(config: import('@expo/config').ConfigContext) => import('@expo/config').ExpoConfig} */
module.exports = ({ config }) => ({
  ...config,
  ios: {
    ...config.ios,
    config: {
      ...config.ios?.config,
      // Uses the non-public env var so the Maps SDK key is NOT in the JS bundle.
      googleMapsApiKey: process.env.GOOGLE_MAPS_API_KEY,
    },
  },
  android: {
    ...config.android,
    config: {
      ...config.android?.config,
      // Uses the non-public env var so the Maps SDK key is NOT in the JS bundle.
      googleMaps: {
        apiKey: process.env.GOOGLE_MAPS_API_KEY,
      },
    },
  },
});
