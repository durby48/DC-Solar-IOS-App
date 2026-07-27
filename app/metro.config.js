// Learn more: https://docs.expo.dev/guides/customizing-metro
const { getDefaultConfig } = require('expo/metro-config');

const config = getDefaultConfig(__dirname);

// Production minification white-screened the web app: React Navigation
// inspects a screen component's function name (lowercase = "render
// function", uppercase = component) and terser's mangling renames every
// component to a lowercase single letter. Keep names intact — costs a
// little bundle size, restores rendering.
config.transformer.minifierConfig = {
  ...config.transformer.minifierConfig,
  keep_classnames: true,
  keep_fnames: true,
  mangle: { keep_classnames: true, keep_fnames: true },
};

module.exports = config;
