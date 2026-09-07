/**
 * `@twilio/voice-sdk/dist/twilio.js` is the SDK's self-contained browser
 * bundle (the file Twilio's own CDN serves). The package only types its
 * `es5/` entry, so this declares the subpath; `lib/voice.web.ts` reads the
 * real `Device` type from the main entry with a type-only import, which is
 * erased at runtime and never loads the ESM build Metro cannot evaluate.
 */
declare module '@twilio/voice-sdk/dist/twilio.js' {
  const bundle: unknown;
  export = bundle;
}
