import { useEffect, useMemo, useRef, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import MapView, { Marker, Polygon, UrlTile, type Region } from 'react-native-maps';

import { colors, radii, spacing } from '@/constants/theme';
import { STAGE_COLOR, type MapPoint } from '@/lib/leadMap';
import { type StormLayers } from '@/lib/stormLayers';

/**
 * The Lead map on the PHONE (build with runtime 6, 2026-10-09): Apple Maps
 * through react-native-maps — no API key on iOS. Satellite by default (panels
 * visible), a Map / Satellite switch, one coloured dot per lead / customer
 * (faded when the address only placed to the street / ZIP). Tap a dot to
 * select it (the screen shows its card); tap the map to clear. `focusKey`
 * starts zoomed in on that pin; otherwise the map fits every pin. `roof`
 * ("See the roof") flies to a pin at roof level on Satellite.
 *
 * A NATIVE MODULE: this file only exists from the runtime-6 build on. Build 33
 * (runtime 5) never receives it over the air.
 */
export const NATIVE_MAP = true;

const KANSAS_CITY: Region = { latitude: 39.0997, longitude: -94.5786, latitudeDelta: 0.5, longitudeDelta: 0.5 };
const ROOF_DELTA = 0.0025;

function fitRegion(points: MapPoint[]): Region {
  if (points.length === 0) return KANSAS_CITY;
  let minLat = Infinity;
  let maxLat = -Infinity;
  let minLng = Infinity;
  let maxLng = -Infinity;
  for (const p of points) {
    minLat = Math.min(minLat, p.lat);
    maxLat = Math.max(maxLat, p.lat);
    minLng = Math.min(minLng, p.lng);
    maxLng = Math.max(maxLng, p.lng);
  }
  return {
    latitude: (minLat + maxLat) / 2,
    longitude: (minLng + maxLng) / 2,
    latitudeDelta: Math.max(0.02, (maxLat - minLat) * 1.3),
    longitudeDelta: Math.max(0.02, (maxLng - minLng) * 1.3),
  };
}

export function LeadMapView({
  points,
  selectedKey,
  onSelect,
  roof,
  focusKey,
  storms,
}: {
  points: MapPoint[];
  selectedKey: string | null;
  onSelect: (key: string | null) => void;
  roof?: { key: string; n: number } | null;
  focusKey?: string | null;
  /** Storm coverage (2026-10-09): radar, NWS warnings, hail / wind reports. */
  storms?: StormLayers | null;
}) {
  const map = useRef<MapView>(null);
  const [satellite, setSatellite] = useState(true);

  const initialRegion = useMemo<Region>(() => {
    const f = focusKey ? points.find((p) => p.key === focusKey) : undefined;
    if (f) return { latitude: f.lat, longitude: f.lng, latitudeDelta: ROOF_DELTA, longitudeDelta: ROOF_DELTA };
    return fitRegion(points);
    // Only the first render's points decide where the map starts.
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!roof) return;
    const p = points.find((x) => x.key === roof.key);
    if (!p) return;
    setSatellite(true);
    map.current?.animateToRegion(
      { latitude: p.lat, longitude: p.lng, latitudeDelta: ROOF_DELTA / 2, longitudeDelta: ROOF_DELTA / 2 },
      900,
    );
  }, [roof]); // eslint-disable-line react-hooks/exhaustive-deps

  // A storm opened from its report: zoom to its hail.
  useEffect(() => {
    const fit = storms?.fitTo;
    if (!fit || fit.length === 0) return;
    map.current?.fitToCoordinates(
      fit.map((p) => ({ latitude: p.lat, longitude: p.lng })),
      { edgePadding: { top: 60, right: 60, bottom: 60, left: 60 }, animated: true },
    );
  }, [storms?.fitTo]);

  return (
    <View style={styles.wrap}>
      <MapView
        ref={map}
        style={StyleSheet.absoluteFill}
        initialRegion={initialRegion}
        mapType={satellite ? 'hybrid' : 'standard'}
        userInterfaceStyle="dark"
        showsUserLocation={false}
        onPress={(e) => {
          if (e.nativeEvent.action !== 'marker-press') onSelect(null);
        }}>
        {storms?.radar ? (
          <UrlTile
            urlTemplate="https://mesonet.agron.iastate.edu/cache/tile.py/1.0.0/nexrad-n0q-900913/{z}/{x}/{y}.png"
            opacity={0.6}
            zIndex={2}
            maximumZ={19}
          />
        ) : null}
        {(storms?.warnings ?? []).flatMap((w) =>
          w.rings.map((ring, i) => (
            <Polygon
              key={`${w.id}-${i}`}
              coordinates={ring.map(([lat, lng]) => ({ latitude: lat, longitude: lng }))}
              strokeColor={w.tornado ? '#FF4D4D' : '#FFB020'}
              fillColor={w.tornado ? 'rgba(255,77,77,0.12)' : 'rgba(255,176,32,0.12)'}
              strokeWidth={2}
            />
          )),
        )}
        {(storms?.reports ?? []).map((r) => {
          const hail = r.kind === 'hail';
          const d = hail ? 8 + Math.min(20, (r.size ?? 1) * 6) : 8;
          return (
            <Marker
              key={r.id}
              coordinate={{ latitude: r.lat, longitude: r.lng }}
              title={r.label}
              tracksViewChanges={false}
              anchor={{ x: 0.5, y: 0.5 }}
              zIndex={0}>
              <View
                style={{
                  width: d,
                  height: d,
                  borderRadius: d / 2,
                  backgroundColor: hail ? 'rgba(63,169,245,0.55)' : 'rgba(255,140,26,0.55)',
                  borderWidth: 1.5,
                  borderColor: hail ? '#BFE3FF' : '#FFB020',
                }}
              />
            </Marker>
          );
        })}
        {points.map((p) => {
          const on = p.key === selectedKey;
          return (
            <Marker
              key={p.key}
              coordinate={{ latitude: p.lat, longitude: p.lng }}
              onPress={() => onSelect(p.key)}
              tracksViewChanges={false}
              anchor={{ x: 0.5, y: 0.5 }}
              zIndex={on ? 10 : 1}>
              <View
                style={[
                  styles.dot,
                  on && styles.dotOn,
                  { backgroundColor: STAGE_COLOR[p.stage], opacity: p.approx ? 0.6 : 1 },
                ]}
              />
            </Marker>
          );
        })}
      </MapView>
      <View style={styles.switch}>
        {(['Map', 'Satellite'] as const).map((label) => {
          const active = (label === 'Satellite') === satellite;
          return (
            <Pressable
              key={label}
              onPress={() => setSatellite(label === 'Satellite')}
              style={[styles.switchItem, active && styles.switchItemOn]}>
              <Text style={[styles.switchText, active && styles.switchTextOn]}>{label}</Text>
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { flex: 1, minHeight: 320, borderRadius: radii.md, overflow: 'hidden', backgroundColor: colors.surface },
  dot: { width: 14, height: 14, borderRadius: 7, borderWidth: 1.5, borderColor: '#1E1C1A' },
  dotOn: { width: 22, height: 22, borderRadius: 11, borderWidth: 3, borderColor: '#FFFFFF' },
  switch: {
    position: 'absolute',
    left: spacing.sm,
    top: spacing.sm,
    flexDirection: 'row',
    backgroundColor: 'rgba(0,0,0,0.6)',
    borderRadius: radii.pill,
    padding: 3,
  },
  switchItem: { paddingHorizontal: 12, paddingVertical: 5, borderRadius: radii.pill },
  switchItemOn: { backgroundColor: colors.sun },
  switchText: { color: '#fff', fontSize: 12, fontWeight: '800' },
  switchTextOn: { color: colors.textOnAction },
});
