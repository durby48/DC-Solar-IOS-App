import { memo, useEffect, useMemo, useRef, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import MapView, { Circle, Marker, Polygon, UrlTile, type Region } from 'react-native-maps';

import { colors, radii, spacing } from '@/constants/theme';
import { STAGE_COLOR, type MapPoint } from '@/lib/leadMap';
import { ZONE_METERS, zoneColor, type MapViewState, type StormLayers } from '@/lib/stormLayers';

/**
 * The Lead map on the PHONE (runtime 6, 2026-10-09): Apple Maps through
 * react-native-maps — no API key on iOS. Satellite by default (panels
 * visible) with Apple's labels; a Map / Satellite switch; `labels` off =
 * plain satellite. One coloured dot per lead / customer (faded when the
 * address only placed to the street / ZIP). Tap a dot to select it (the
 * screen shows its card); tap the map to clear.
 *
 * Moves on its own only when asked: `focusKey` at first load (zoomed in on
 * that pin), otherwise it opens over Kansas City; `storms.fitKey` changing (a
 * storm picked) zooms to that storm; `roof` flies to a pin at roof level.
 *
 * STORMS: each report's 3-mile zone (coloured by hail size; wind orange),
 * report dots, NWS warning polygons and live radar tiles. With a storm
 * picked, pins in its path get a white ring and the rest fade.
 *
 * A NATIVE MODULE: only from the runtime-6 build on (Build 33 never gets it).
 */
export const NATIVE_MAP = true;

const KANSAS_CITY: Region = { latitude: 39.0997, longitude: -94.5786, latitudeDelta: 0.5, longitudeDelta: 0.5 };
const ROOF_DELTA = 0.0025;

/** One pin; memoised so a selection change re-renders only the pins it touches. */
const Pin = memo(function Pin({
  p,
  state,
  onPress,
}: {
  p: MapPoint;
  state: 'normal' | 'selected' | 'inPath' | 'faded';
  onPress: (key: string) => void;
}) {
  const size = state === 'selected' ? 22 : state === 'inPath' ? 18 : 14;
  return (
    <Marker
      coordinate={{ latitude: p.lat, longitude: p.lng }}
      onPress={() => onPress(p.key)}
      tracksViewChanges={false}
      anchor={{ x: 0.5, y: 0.5 }}
      zIndex={state === 'selected' ? 10 : state === 'inPath' ? 5 : 1}>
      <View
        style={{
          width: size,
          height: size,
          borderRadius: size / 2,
          borderWidth: state === 'selected' ? 3 : state === 'inPath' ? 2.5 : 1.5,
          borderColor: state === 'selected' || state === 'inPath' ? '#FFFFFF' : '#1E1C1A',
          backgroundColor: STAGE_COLOR[p.stage],
          opacity: state === 'faded' ? 0.25 : p.approx ? 0.6 : 1,
        }}
      />
    </Marker>
  );
});

export function LeadMapView({
  points,
  selectedKey,
  onSelect,
  roof,
  focusKey,
  storms,
  labels = true,
  controlsTop,
  initialView = null,
  onViewChange,
}: {
  points: MapPoint[];
  selectedKey: string | null;
  onSelect: (key: string | null) => void;
  roof?: { key: string; n: number } | null;
  focusKey?: string | null;
  storms?: StormLayers | null;
  labels?: boolean;
  /** Where the Map / Satellite switch sits (full screen: under the Close row). */
  controlsTop?: number;
  /** Start exactly here (the full-screen map opening where the small one was). */
  initialView?: MapViewState | null;
  /** Reports where the map is looking after every move. */
  onViewChange?: (view: MapViewState) => void;
}) {
  const map = useRef<MapView>(null);
  const [satellite, setSatellite] = useState(true);
  // Opening where another map was: the storm is already in view, no re-zoom.
  const lastFit = useRef<string | null>(initialView ? (storms?.fitKey ?? null) : null);

  const initialRegion = useMemo<Region>(() => {
    if (initialView) {
      const delta = 360 / 2 ** initialView.zoom;
      return { latitude: initialView.lat, longitude: initialView.lng, latitudeDelta: delta, longitudeDelta: delta };
    }
    const f = focusKey ? points.find((p) => p.key === focusKey) : undefined;
    if (f) return { latitude: f.lat, longitude: f.lng, latitudeDelta: ROOF_DELTA, longitudeDelta: ROOF_DELTA };
    // Default: over Kansas City (2026-10-09, Carson) — fitting every pin
    // zoomed out across the whole region.
    return KANSAS_CITY;
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

  // A storm picked: zoom to it (once per pick).
  const fitKey = storms?.fitKey ?? null;
  useEffect(() => {
    const reports = storms?.reports ?? [];
    if (!fitKey || fitKey === lastFit.current || reports.length === 0) {
      if (!fitKey) lastFit.current = null;
      return;
    }
    lastFit.current = fitKey;
    map.current?.fitToCoordinates(
      reports.map((r) => ({ latitude: r.lat, longitude: r.lng })),
      { edgePadding: { top: 80, right: 60, bottom: 80, left: 60 }, animated: true },
    );
  }, [fitKey, storms?.reports]);

  const highlight = storms?.highlight ?? null;
  const select = useRef(onSelect);
  select.current = onSelect;
  const press = useMemo(() => (key: string) => select.current(key), []);

  return (
    <View style={styles.wrap}>
      <MapView
        ref={map}
        style={StyleSheet.absoluteFill}
        initialRegion={initialRegion}
        mapType={satellite ? (labels ? 'hybrid' : 'satellite') : 'standard'}
        userInterfaceStyle="dark"
        showsUserLocation={false}
        rotateEnabled={false}
        pitchEnabled={false}
        onRegionChangeComplete={(r) =>
          onViewChange?.({ lat: r.latitude, lng: r.longitude, zoom: Math.log2(360 / Math.max(r.longitudeDelta, 1e-6)) })
        }
        onPress={(e) => {
          if (e.nativeEvent.action !== 'marker-press') onSelect(null);
        }}>
        {storms?.radar ? (
          <UrlTile
            urlTemplate="https://mesonet.agron.iastate.edu/cache/tile.py/1.0.0/nexrad-n0q-900913/{z}/{x}/{y}.png"
            opacity={0.55}
            zIndex={2}
            maximumZ={16}
          />
        ) : null}
        {(storms?.warnings ?? []).flatMap((w) =>
          w.rings.map((ring, i) => (
            <Polygon
              key={`${w.id}-${i}`}
              coordinates={ring.map(([lat, lng]) => ({ latitude: lat, longitude: lng }))}
              strokeColor={w.tornado ? '#FF4D4D' : '#FFB020'}
              fillColor={w.tornado ? 'rgba(255,77,77,0.10)' : 'rgba(255,176,32,0.10)'}
              strokeWidth={2}
            />
          )),
        )}
        {(storms?.reports ?? []).map((r) => (
          <Circle
            key={`zone-${r.id}`}
            center={{ latitude: r.lat, longitude: r.lng }}
            radius={ZONE_METERS}
            strokeWidth={0}
            fillColor={`${zoneColor(r)}29`}
          />
        ))}
        {(storms?.reports ?? []).map((r) => (
          <Marker
            key={r.id}
            coordinate={{ latitude: r.lat, longitude: r.lng }}
            title={r.label}
            tracksViewChanges={false}
            anchor={{ x: 0.5, y: 0.5 }}
            zIndex={0}>
            <View style={[styles.report, { backgroundColor: zoneColor(r) }]} />
          </Marker>
        ))}
        {points.map((p) => (
          <Pin
            key={p.key}
            p={p}
            state={
              p.key === selectedKey
                ? 'selected'
                : highlight?.has(p.key)
                  ? 'inPath'
                  : highlight
                    ? 'faded'
                    : 'normal'
            }
            onPress={press}
          />
        ))}
      </MapView>
      <View style={[styles.switch, controlsTop !== undefined && { top: controlsTop }]}>
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
  report: { width: 8, height: 8, borderRadius: 4, borderWidth: 1, borderColor: '#FFFFFF' },
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
