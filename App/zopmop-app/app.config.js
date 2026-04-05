// Dynamic config — extends app.json and injects env vars into native build.
// Expo reads this automatically. Never hardcode API keys here.

/** @type {(config: import('@expo/config').ConfigContext) => import('@expo/config').ExpoConfig} */
module.exports = ({ config }) => ({
  ...config,
  ios: {
    ...config.ios,
    config: {
      ...config.ios?.config,
      // Injects GMSServices key into iOS native build (required by react-native-maps)
      googleMapsApiKey: process.env.EXPO_PUBLIC_GOOGLE_MAPS_API_KEY,
    },
  },
  android: {
    ...config.android,
    config: {
      ...config.android?.config,
      // Injects Google Maps API key into AndroidManifest (required by react-native-maps)
      googleMaps: {
        apiKey: process.env.EXPO_PUBLIC_GOOGLE_MAPS_API_KEY,
      },
    },
  },
});
