# TODO before the build: add the Google Sign-In config plugin

`@react-native-google-signin/google-signin@16.1.4` is installed and locked as part
of the build-29 native manifest, **but its config plugin is deliberately NOT in
`app.json` yet.** The plugin needs a value that does not exist yet.

## Why it is missing

The plugin's only required prop is `iosUrlScheme` — the **reversed iOS OAuth
client ID** from Google Cloud. Devon has not created the iOS OAuth client yet
(owner action item #4 in the 2026-08 overhaul plan). Adding the plugin with a
placeholder would produce a native build that registers a bogus URL scheme and
fails the Google sign-in round trip, and every failed EAS attempt burns a build
number.

`npx expo install` auto-added the bare string `"@react-native-google-signin/google-signin"`
to `app.json`; that entry was **removed on purpose**. Do not let a later
`expo install` re-add it in the bare form.

## What Devon has to do first

1. Google Cloud Console → **APIs & Services → OAuth consent screen** (External;
   scopes `email`, `profile`, `openid`).
2. Create a **Web** OAuth client — authorized redirect URI
   `https://kjamxfezsathrsbztiln.supabase.co/auth/v1/callback`.
3. Create an **iOS** OAuth client for bundle id `com.dcsolarkc.fieldapp`.
4. Copy the iOS client's **reversed client ID**. Google shows it on the client
   detail page as "iOS URL scheme"; it is the client ID with its two
   dot-separated halves swapped, e.g.

   ```
   iOS client ID   1234567890-abcdefghijklmnop.apps.googleusercontent.com
   reversed        com.googleusercontent.apps.1234567890-abcdefghijklmnop
   ```

## The exact entry to add

Append this to `expo.plugins` in `app/app.json` (after the `expo-sensors`
entry), substituting the reversed iOS client ID:

```json
[
  "@react-native-google-signin/google-signin",
  {
    "iosUrlScheme": "com.googleusercontent.apps.<REVERSED_IOS_CLIENT_ID>"
  }
]
```

Then also set, in `app/.env`:

```
EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID=<web client id>.apps.googleusercontent.com
EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID=<ios client id>.apps.googleusercontent.com
```

## Blocking status

**The iOS build must wait for this.** Google sign-in is a native capability: it
cannot be added by an OTA update. If build 29 ships without the plugin, Google
sign-in stays broken until build 30, even though the JavaScript is on the phone.

After editing `app.json`:

```
cd app
npx expo config --type public          # must parse
npx expo export --platform web         # must succeed
npx tsc --noEmit                       # must be clean
```

`runtimeVersion` stays `"2"` and `version` stays `"1.0.0"` — do not touch either.
