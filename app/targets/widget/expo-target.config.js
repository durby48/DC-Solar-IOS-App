/**
 * DC Solar home-screen widget target (WidgetKit, SwiftUI — see index.swift).
 * Shares data with the app through the App Group defined in app.json.
 */
/** @type {import('@bacons/apple-targets/app.plugin').ConfigFunction} */
module.exports = (config) => ({
  type: 'widget',
  name: 'widget',
  displayName: 'DC Solar',
  bundleIdentifier: '.widget',
  deploymentTarget: '17.0',
  colors: {
    // Theme tokens from src/constants/theme.ts (sun / cream).
    $accent: '#FFB066',
    $widgetBackground: '#FFF3E6',
  },
  entitlements: {
    'com.apple.security.application-groups':
      config.ios.entitlements['com.apple.security.application-groups'],
  },
});
