import Ionicons from '@expo/vector-icons/Ionicons';
import { Image } from 'expo-image';
import { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { colors, radii, spacing } from '@/constants/theme';

/**
 * The map at the bottom of a lead's / customer's panel (2026-10-09, Carson):
 * a satellite picture of the spot (panels visible) with a pin, and a tap
 * opens the full Lead map zoomed in on it. A picture rather than a live map,
 * on purpose: it loads at once, works on the web and on every iPhone build,
 * and does not fight the panel's scrolling; the full map is the live one.
 *
 * Esri World Imagery's `export` endpoint renders the box around the point
 * (keyless, like the Lead map's satellite tiles).
 */
const ESRI_EXPORT = 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/export';
const HEIGHT = 170;
/** Longitude span of the picture — roughly a block and a half. */
const LON_SPAN = 0.0032;

export function RecordMiniMap({
  lat,
  lng,
  approx = false,
  onOpen,
}: {
  lat: number;
  lng: number;
  /** Placed to the street / ZIP, not the building. */
  approx?: boolean;
  onOpen: () => void;
}) {
  const [width, setWidth] = useState(0);

  let url: string | null = null;
  if (width > 0) {
    const latSpan = LON_SPAN * (HEIGHT / width) * Math.cos((lat * Math.PI) / 180);
    const bbox = [lng - LON_SPAN / 2, lat - latSpan / 2, lng + LON_SPAN / 2, lat + latSpan / 2].map((n) => n.toFixed(6)).join(',');
    const w = Math.round(width * 2);
    const h = Math.round(HEIGHT * 2);
    url = `${ESRI_EXPORT}?bbox=${bbox}&bboxSR=4326&imageSR=3857&size=${w},${h}&format=jpg&f=image`;
  }

  return (
    <Pressable
      onPress={onOpen}
      onLayout={(e) => setWidth(Math.round(e.nativeEvent.layout.width))}
      accessibilityRole="button"
      accessibilityLabel="Open the map"
      style={({ pressed }) => [styles.box, pressed && styles.pressed]}>
      {url ? <Image source={{ uri: url }} style={StyleSheet.absoluteFill} contentFit="cover" transition={150} /> : null}
      <View pointerEvents="none" style={styles.pinWrap}>
        <Ionicons name="location" size={34} color={colors.sun} style={styles.pin} />
      </View>
      <View pointerEvents="none" style={styles.caption}>
        <Ionicons name="expand" size={12} color="#fff" />
        <Text style={styles.captionText}>{approx ? 'Approximate · tap for the map' : 'Tap for the map'}</Text>
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  box: {
    height: HEIGHT,
    borderRadius: radii.md,
    overflow: 'hidden',
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.line,
  },
  pressed: { opacity: 0.8 },
  // The pin's TIP sits on the point: the icon is drawn above the centre.
  pinWrap: { position: 'absolute', left: 0, right: 0, top: 0, bottom: 0, alignItems: 'center', justifyContent: 'center', paddingBottom: 34 },
  pin: { textShadowColor: 'rgba(0,0,0,0.6)', textShadowRadius: 4, textShadowOffset: { width: 0, height: 1 } },
  caption: {
    position: 'absolute',
    left: spacing.sm,
    bottom: spacing.sm,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    backgroundColor: 'rgba(0,0,0,0.6)',
    borderRadius: radii.pill,
    paddingHorizontal: 9,
    paddingVertical: 4,
  },
  captionText: { color: '#fff', fontSize: 11, fontWeight: '800' },
});
