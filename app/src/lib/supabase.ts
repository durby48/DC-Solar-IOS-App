import AsyncStorage from '@react-native-async-storage/async-storage';
import { createClient } from '@supabase/supabase-js';
import { Platform } from 'react-native';

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
