import AsyncStorage from '@react-native-async-storage/async-storage';
import { createClient } from '@supabase/supabase-js';
import { AppState, Platform } from 'react-native';

const supabaseUrl = process.env.EXPO_PUBLIC_SUPABASE_URL ?? '';
const supabaseKey = process.env.EXPO_PUBLIC_SUPABASE_KEY ?? '';

export const supabase = createClient(supabaseUrl, supabaseKey, {
  auth: {
    // On web (including static prerender, where `window` is undefined),
    // let supabase-js use its SSR-safe default storage.
    ...(Platform.OS !== 'web' ? { storage: AsyncStorage } : {}),
    autoRefreshToken: true,
    persistSession: true,
    // Web only, and it is what makes the customer-portal invite work.
    //
    // We stay on the IMPLICIT flow (no PKCE): Supabase delivers invite,
    // recovery and email-confirm links to the browser as a URL *fragment*
    // (`.../set-password#access_token=…&refresh_token=…`). Nothing but
    // supabase-js reads that fragment — with this off, the tokens sat in the
    // address bar, no session was ever created, and every invited customer
    // landed on an empty "create your password" form that could not save.
    //
    // PKCE would put a `?code=` in the query instead, but it needs the code
    // verifier that was stored by the browser that STARTED the flow. Invites
    // start on the server, so there is no verifier — the exchange would fail.
    //
    // On native there is no URL to read; deep links are handled by the router,
    // so leave it off there (it also touches `window` during static prerender).
    detectSessionInUrl: Platform.OS === 'web',
  },
});

/**
 * Keep the crew signed in across app switches (native only).
 *
 * `autoRefreshToken` runs on a JS timer, and iOS suspends that timer the moment
 * the app leaves the foreground. An access token lives one hour, so a phone
 * that sat in a pocket all morning came back holding an expired one; every
 * query then failed until something forced a refresh, which reads as "it logged
 * me out again". Supabase's own React Native guidance is to drive the refresher
 * from AppState instead of leaving it to that timer, so the refresh happens on
 * RESUME rather than on a schedule that iOS is free to ignore.
 *
 * Stopping it on background matters as much as starting it: a refresher firing
 * while suspended burns a rotated refresh token that the next resume then can't
 * use, and rotation is ON for this project
 * (`security_refresh_token_reuse_interval` = 10s).
 *
 * Web is exempt — the browser keeps its own timers alive and supabase-js
 * handles visibility there itself.
 */
if (Platform.OS !== 'web') {
  AppState.addEventListener('change', (state) => {
    if (state === 'active') {
      void supabase.auth.startAutoRefresh();
    } else {
      void supabase.auth.stopAutoRefresh();
    }
  });
}
