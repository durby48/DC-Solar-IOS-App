import Ionicons from '@expo/vector-icons/Ionicons';
import { Linking, StyleSheet, View } from 'react-native';

import { AppText, Button } from '@/components/ui';
import { colors, radii, spacing } from '@/constants/theme';
import { type MapPoint } from '@/lib/leadMap';

/**
 * The Lead map on the PHONE (2026-10-07) — not yet. A native map
 * (react-native-maps / Apple Maps) is a native module, so it can only arrive
 * with a new TestFlight build (a runtime bump); importing it in an
 * over-the-air update to the current build would crash the app. Until then
 * this says so and opens the web map, where it already works.
 * LeadMapView.web.tsx is the real map.
 */
export function LeadMapView({ points }: { points: MapPoint[]; selectedKey: string | null; onSelect: (key: string | null) => void }) {
  return (
    <View style={styles.card}>
      <Ionicons name="map" size={28} color={colors.ocean} />
      <AppText variant="heading" align="center">
        {points.length} on the map
      </AppText>
      <AppText variant="body" color={colors.textSecondary} align="center">
        The map is on app.dcsolarkc.com for now. It comes to the iPhone app in the next app update.
      </AppText>
      <Button label="Open the map" icon="open-outline" onPress={() => void Linking.openURL('https://app.dcsolarkc.com/lead-map')} />
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    flex: 1,
    minHeight: 320,
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.sm,
    padding: spacing.lg,
    borderRadius: radii.md,
    backgroundColor: colors.surface,
  },
});
