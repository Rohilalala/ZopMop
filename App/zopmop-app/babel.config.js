module.exports = function (api) {
  api.cache(true);
  const isProduction =
    process.env.NODE_ENV === 'production' || process.env.EAS_BUILD === 'true';
  return {
    presets: [
      ['babel-preset-expo', { jsxImportSource: 'nativewind' }],
      'nativewind/babel',
    ],
    plugins: [
      'react-native-reanimated/plugin',
      ...(isProduction
        ? [['transform-remove-console', { exclude: ['error', 'warn'] }]]
        : []),
    ],
  };
};
