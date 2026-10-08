import Ionicons from '@expo/vector-icons/Ionicons';
import { type ComponentProps, type ReactNode } from 'react';
import { Modal, Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import { SafeAreaProvider, useSafeAreaInsets } from 'react-native-safe-area-context';

import { LeadMapView } from '@/components/map/LeadMapView';
import { colors, radii, spacing } from '@/constants/theme';
import { ZONE_LEGEND } from '@/lib/stormLayers';

/**
 * The map, full screen (2026-10-09, Carson: "make it so you can full screen
 * it on the phone"). The same map — pins, the picked storm's zones, the
 * highlight, labels — filling the whole screen, with a close button, an
 * optional title (e.g. the storm) and the hail colour legend when storm
 * zones are showing. `footer` is for the tapped pin's card.
 */
export function MapFullScreen({
  visible,
  onClose,
  title,
  footer,
  windLegend = false,
  ...map
}: ComponentProps<typeof LeadMapView> & {
  visible: boolean;
  onClose: () => void;
  title?: string | null;
  footer?: ReactNode;
  /** Wind storm picked: one orange swatch instead of the hail sizes. */
  windLegend?: boolean;
}) {
  return (
    <Modal visible={visible} animationType="fade" presentationStyle="fullScreen" onRequestClose={onClose} statusBarTranslucent>
      {/* A Modal is its own native window: give it its own SafeAreaProvider,
          or the insets can read 0 and Close lands under the status bar /
          Dynamic Island, where it cannot be tapped (fixed 2026-10-09). */}
      <SafeAreaProvider>
        <FullScreenBody visible={visible} onClose={onClose} title={title} footer={footer} windLegend={windLegend} map={map} />
      </SafeAreaProvider>
    </Modal>
  );
}

function FullScreenBody({
  visible,
  onClose,
  title,
  footer,
  windLegend,
  map,
}: {
  visible: boolean;
  onClose: () => void;
  title?: string | null;
  footer?: ReactNode;
  windLegend: boolean;
  map: ComponentProps<typeof LeadMapView>;
}) {
  const insets = useSafeAreaInsets();
  // Never closer to the top than the status bar, even if insets still read 0.
  const top = Math.max(insets.top, Platform.OS === 'ios' ? 50 : Platform.OS === 'android' ? 28 : 0) + spacing.sm;
  const showLegend = (map.storms?.reports.length ?? 0) > 0;

  return (
    <>
      <View style={styles.screen}>
        {/* The map's own Map / Satellite switch sits under the Close row. */}
        {visible ? <LeadMapView {...map} controlsTop={top + 48} /> : null}

        <View pointerEvents="box-none" style={[styles.top, { top }]}>
          <Pressable
            onPress={onClose}
            accessibilityRole="button"
            accessibilityLabel="Close the full-screen map"
            hitSlop={8}
            style={({ pressed }) => [styles.close, pressed && styles.pressed]}>
            <Ionicons name="contract" size={18} color="#fff" />
            <Text style={styles.closeText}>Close</Text>
          </Pressable>
          {title ? (
            <View style={styles.title}>
              <Text style={styles.titleText} numberOfLines={1}>
                {title}
              </Text>
            </View>
          ) : null}
        </View>

        <View pointerEvents="box-none" style={[styles.bottom, { bottom: insets.bottom + spacing.sm }]}>
          {footer}
          {showLegend ? (
            <View pointerEvents="none" style={styles.legend}>
              {windLegend ? (
                <View style={styles.legendItem}>
                  <View style={[styles.swatch, { backgroundColor: '#FF8C1A' }]} />
                  <Text style={styles.legendText}>Damaging wind</Text>
                </View>
              ) : (
                ZONE_LEGEND.map((l) => (
                  <View key={l.label} style={styles.legendItem}>
                    <View style={[styles.swatch, { backgroundColor: l.color }]} />
                    <Text style={styles.legendText}>{l.label}</Text>
                  </View>
                ))
              )}
            </View>
          ) : null}
        </View>
      </View>
    </>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.surfaceAlt },
  top: { position: 'absolute', left: spacing.md, right: spacing.md, flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  close: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    backgroundColor: 'rgba(0,0,0,0.7)',
    borderRadius: radii.pill,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  closeText: { color: '#fff', fontSize: 13, fontWeight: '800' },
  title: { flexShrink: 1, backgroundColor: 'rgba(0,0,0,0.6)', borderRadius: radii.pill, paddingHorizontal: 12, paddingVertical: 7 },
  titleText: { color: '#fff', fontSize: 13, fontWeight: '800' },
  bottom: { position: 'absolute', left: spacing.md, right: spacing.md, alignItems: 'center', gap: spacing.sm },
  legend: {
    flexDirection: 'row',
    gap: 10,
    backgroundColor: 'rgba(0,0,0,0.65)',
    borderRadius: radii.pill,
    paddingHorizontal: 12,
    paddingVertical: 6,
  },
  legendItem: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  swatch: { width: 10, height: 10, borderRadius: 5 },
  legendText: { color: '#fff', fontSize: 11, fontWeight: '700' },
  pressed: { opacity: 0.6 },
});
