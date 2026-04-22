// Metro config — Expo defaults + svg-as-component via react-native-svg-transformer.
const { getDefaultConfig } = require('expo/metro-config');

const config = getDefaultConfig(__dirname);

const { transformer, resolver } = config;

config.transformer = {
  ...transformer,
  babelTransformerPath: require.resolve('react-native-svg-transformer/expo'),
};
config.resolver = {
  ...resolver,
  assetExts: [...resolver.assetExts.filter((ext) => ext !== 'svg'), 'lottie'],
  sourceExts: [...resolver.sourceExts, 'svg'],
};

module.exports = config;
