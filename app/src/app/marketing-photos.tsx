import Ionicons from '@expo/vector-icons/Ionicons';
import { Stack } from 'expo-router';
import { useEffect, useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { MediaGallery } from '@/components/MediaGrid';
import { AppText, Card } from '@/components/ui';
import { colors, radii, spacing } from '@/constants/theme';
import { supabase } from '@/lib/supabase';

/**
 * Marketing photos — the full gallery.
 *
 * The Marketing panel's strip shows the newest two dozen; this is all of them,
 * with the tag filter, the lightbox, captions, and (for admins) the Dropbox
 * status and a "Sync now" button. `components/MediaGrid.tsx::MediaGallery` is
 * the whole thing — this file is a header, a sign-in gate, and a mount point,
 * which is also why the Sales tab can render the identical gallery inside its
 * Photos segment without either copy drifting from the other.
 *
 * SIGNED OUT GETS A CARD, NOT AN ERROR. `media_assets` is member-SELECT, so a
 * signed-out request comes back empty and indistinguishable from an empty
 * folder. Saying "sign in" is the useful half of that, and it is checked here
 * rather than inside the gallery because the gallery is also mounted in
 * places that already sit behind a gate.
 *
 * The gallery owns its own scrolling (a `FlashList` — a marketing library can
 * run to hundreds of photos), so there is no `ScrollView` on this screen.
 */
export default function MarketingPhotosScreen() {
  const [signedIn, setSignedIn] = useState<boolean | null>(null);

  useEffect(() => {
    let cancelled = false;
    supabase.auth.getSession().then(({ data }) => {
      if (!cancelled) setSignedIn(data.session != null);
    });
    const { data: sub } = supabase.auth.onAuthStateChange((_event, session) => {
      if (!cancelled) setSignedIn(session != null);
    });
    return () => {
      cancelled = true;
      sub.subscription.unsubscribe();
    };
  }, []);

  return (
    <>
      <Stack.Screen options={{ title: 'Marketing photos' }} />
      <View style={styles.screen}>
        {signedIn === false ? (
          <View style={styles.gate}>
            <Card tone="sunk" style={styles.gateCard}>
              <View style={styles.badge}>
                <Ionicons name="images" size={26} color={colors.accentPrimary} />
              </View>
              <AppText variant="heading" align="center">
                Sign in to see the photos
              </AppText>
              <AppText variant="body" color={colors.textMuted} align="center">
                Installation and marketing photos are for the DC Solar crew, so
                they only load once you are signed in.
              </AppText>
            </Card>
          </View>
        ) : (
          <View style={styles.body}>
            <MediaGallery usage="marketing" />
          </View>
        )}
      </View>
    </>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: colors.surfaceAlt,
  },
  body: {
    flex: 1,
    paddingHorizontal: spacing.md,
    paddingTop: spacing.md,
  },
  gate: {
    flex: 1,
    justifyContent: 'center',
    padding: spacing.lg,
  },
  gateCard: {
    alignItems: 'center',
    gap: spacing.sm,
    paddingVertical: spacing.xl,
  },
  badge: {
    width: 56,
    height: 56,
    borderRadius: radii.pill,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.oliveTint,
    marginBottom: spacing.xs,
  },
});
