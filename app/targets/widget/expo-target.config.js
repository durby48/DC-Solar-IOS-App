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
    // Theme tokens from src/constants/theme.ts (sun / card / olive) —
    // the 2026-09-12 "Sonoran dusk" dark palette.
    $accent: '#D8B98A',
    $widgetBackground: '#2A2623',
    $olive: '#A9B894',
    $oliveDeep: '#C4D0B3',
    $oliveSoft: '#2E3A2B',
  },
  entitlements: {
    'com.apple.security.application-groups':
      config.ios.entitlements['com.apple.security.application-groups'],
  },
});
