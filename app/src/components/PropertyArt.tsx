import { Image } from 'expo-image';
import { useMemo } from 'react';
import { StyleSheet, View } from 'react-native';

import { artGreens, artPalettes, colors } from '@/constants/theme';

/**
 * Semi-opaque property artwork for a job card.
 *
 * Two modes:
 *  1. `imageUrl` set — the real cartoonified picture of THAT property
 *     (Street View or Devon's own photo, run through the `property-art`
 *     edge function). This is the intended end state for every job.
 *  2. No image yet — a hand-drawn cartoon house scene, generated
 *     deterministically from the job id so a given job always draws the
 *     same house. This is a placeholder, not the goal, but it means a job
 *     never shows a blank card while its artwork is pending or if Street
 *     View has no coverage for the address.
 *
 * Everything here is plain Views: `react-native-svg` is not installed and
 * adding it would force a native build (see OVERHAUL.md).
 *
 * A white scrim sits over the art so the card text keeps full contrast —
 * the art is decoration, never something the crew has to read through.
 */

/** FNV-1a — stable across platforms, unlike anything hash-ish in JS core. */
function hashString(value: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < value.length; i++) {
    h ^= value.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Small deterministic PRNG so one job id always yields one house. */
function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface SceneSpec {
  palette: (typeof artPalettes)[number];
  lawn: string;
  shrub: string;
  /** House block position/size, as % of the card. */
  houseLeft: number;
  houseWidth: number;
  /** Garage on the left or the right of the front door. */
  garageRight: boolean;
  /** Tree presence + placement. */
  treeLeft: boolean;
  treeRight: boolean;
  /** Number of upper-storey windows (2 or 3). */
  upperWindows: number;
  /** Solar panel rows on the roof (1 or 2). */
  panelRows: number;
  cloudTop: number;
  cloudLeft: number;
}

function buildScene(seed: string): SceneSpec {
  const rand = mulberry32(hashString(seed));
  const pick = <T,>(list: readonly T[]): T => list[Math.floor(rand() * list.length)];
  return {
    palette: pick(artPalettes),
    lawn: pick(artGreens.slice(0, 3)),
    shrub: pick(artGreens.slice(2)),
    houseLeft: 30 + rand() * 12,
    houseWidth: 46 + rand() * 10,
    garageRight: rand() > 0.5,
    treeLeft: rand() > 0.2,
    treeRight: rand() > 0.6,
    upperWindows: rand() > 0.5 ? 3 : 2,
    panelRows: rand() > 0.45 ? 2 : 1,
    cloudTop: 6 + rand() * 10,
    cloudLeft: 8 + rand() * 22,
  };
}

function Tree({ left, scale }: { left: number; scale: number }) {
  const size = 34 * scale;
  return (
    <View style={[styles.treeWrap, { left: `${left}%`, bottom: `${18 + scale * 4}%` }]}>
      <View
        style={[
          styles.canopy,
          { width: size, height: size, borderRadius: size / 2, backgroundColor: '#8FC46E' },
        ]}
      />
      <View
        style={[
          styles.canopy,
          {
            width: size * 0.78,
            height: size * 0.78,
            borderRadius: size,
            backgroundColor: '#A9D389',
            marginTop: -size * 0.62,
            marginLeft: -size * 0.34,
          },
        ]}
      />
      <View style={[styles.trunk, { height: 16 * scale, marginTop: -4 }]} />
    </View>
  );
}

/** The drawn cartoon house scene — used until real artwork exists. */
function DrawnScene({ seed }: { seed: string }) {
  const s = useMemo(() => buildScene(seed), [seed]);
  const { palette } = s;

  return (
    <View style={StyleSheet.absoluteFill}>
      {/* Sky + sun + clouds */}
      <View style={[StyleSheet.absoluteFill, { backgroundColor: palette.sky }]} />
      <View style={styles.sun} />
      <View style={[styles.cloud, { top: `${s.cloudTop}%`, left: `${s.cloudLeft}%` }]} />
      <View
        style={[
          styles.cloud,
          styles.cloudSmall,
          { top: `${s.cloudTop + 12}%`, left: `${s.cloudLeft + 34}%` },
        ]}
      />

      {/* Lawn */}
      <View style={[styles.lawn, { backgroundColor: s.lawn }]} />
      {/* Driveway sweeping to the garage */}
      <View style={styles.driveway} />

      {/* House */}
      <View style={[styles.house, { left: `${s.houseLeft}%`, width: `${s.houseWidth}%` }]}>
        {/* Roof: the classic border-triangle trick (no SVG available) */}
        <View style={styles.roofWrap}>
          <View style={[styles.roof, { borderBottomColor: palette.roof }]} />
          {/* Solar panels — this is a solar company, the roofs have panels */}
          <View style={styles.panelStack}>
            {Array.from({ length: s.panelRows }).map((_, row) => (
              <View key={row} style={styles.panelRow}>
                {Array.from({ length: 3 }).map((__, col) => (
                  <View key={col} style={styles.panel} />
                ))}
              </View>
            ))}
          </View>
        </View>

        {/* Body */}
        <View style={[styles.body, { backgroundColor: palette.siding }]}>
          <View style={styles.bodyRow}>
            {Array.from({ length: s.upperWindows }).map((_, i) => (
              <View key={i} style={[styles.window, { borderColor: palette.trim }]}>
                <View style={styles.mullionV} />
              </View>
            ))}
          </View>
          <View style={[styles.bodyRow, styles.bodyRowLower]}>
            {s.garageRight ? <View style={styles.door} /> : null}
            <View style={[styles.garage, { borderColor: palette.trim }]}>
              <View style={styles.garageLine} />
              <View style={styles.garageLine} />
            </View>
            {s.garageRight ? null : <View style={styles.door} />}
          </View>
          {/* Brick skirt */}
          <View style={[styles.brick, { backgroundColor: palette.brick }]} />
        </View>
      </View>

      {/* Foliage */}
      {s.treeLeft ? <Tree left={4} scale={1.15} /> : null}
      {s.treeRight ? <Tree left={86} scale={0.9} /> : null}
      <View style={[styles.shrub, { left: '30%', backgroundColor: s.shrub }]} />
      <View style={[styles.shrub, { left: '38%', backgroundColor: s.shrub }]} />
    </View>
  );
}

export function PropertyArt({
  seed,
  imageUrl,
  radius,
}: {
  /** Stable per-job seed — pass the job id. */
  seed: string;
  /** Cartoonified photo of the real property, once one exists. */
  imageUrl?: string | null;
  radius: number;
}) {
  return (
    <View
      pointerEvents="none"
      style={[StyleSheet.absoluteFill, { borderRadius: radius, overflow: 'hidden' }]}>
      {imageUrl ? (
        <Image
          source={{ uri: imageUrl }}
          style={StyleSheet.absoluteFill}
          contentFit="cover"
          transition={220}
          cachePolicy="memory-disk"
        />
      ) : (
        <DrawnScene seed={seed} />
      )}
      {/* Readability scrim — the card text sits on top of this. */}
      <View style={styles.scrim} />
      {/* Slightly denser band behind the top chip row. */}
      <View style={styles.topScrim} />
    </View>
  );
}

const styles = StyleSheet.create({
  scrim: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: 'rgba(255,255,255,0.80)',
  },
  topScrim: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    height: '34%',
    backgroundColor: 'rgba(255,255,255,0.30)',
  },
  sun: {
    position: 'absolute',
    top: '8%',
    right: '8%',
    width: 30,
    height: 30,
    borderRadius: 15,
    backgroundColor: '#FFD98A',
  },
  cloud: {
    position: 'absolute',
    width: 42,
    height: 14,
    borderRadius: 10,
    backgroundColor: 'rgba(255,255,255,0.85)',
  },
  cloudSmall: {
    width: 26,
    height: 10,
  },
  lawn: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    height: '42%',
  },
  driveway: {
    position: 'absolute',
    bottom: 0,
    left: '46%',
    width: '30%',
    height: '26%',
    backgroundColor: '#D9D3CA',
    transform: [{ skewX: '-12deg' }],
  },
  house: {
    position: 'absolute',
    bottom: '20%',
    height: '58%',
  },
  roofWrap: {
    alignItems: 'center',
  },
  roof: {
    width: 0,
    height: 0,
    borderLeftWidth: 62,
    borderRightWidth: 62,
    borderBottomWidth: 30,
    borderLeftColor: 'transparent',
    borderRightColor: 'transparent',
  },
  panelStack: {
    position: 'absolute',
    top: 8,
    gap: 2,
  },
  panelRow: {
    flexDirection: 'row',
    gap: 2,
  },
  panel: {
    width: 14,
    height: 7,
    borderRadius: 1,
    backgroundColor: '#31527A',
  },
  body: {
    flex: 1,
    marginTop: -2,
    borderTopLeftRadius: 2,
    borderTopRightRadius: 2,
    paddingHorizontal: 6,
    paddingTop: 6,
    justifyContent: 'flex-start',
    gap: 4,
    overflow: 'hidden',
  },
  bodyRow: {
    flexDirection: 'row',
    justifyContent: 'center',
    alignItems: 'flex-end',
    gap: 6,
  },
  bodyRowLower: {
    marginTop: 2,
  },
  window: {
    width: 16,
    height: 13,
    backgroundColor: '#BBD9EE',
    borderWidth: 1.5,
    alignItems: 'center',
  },
  mullionV: {
    width: 1.5,
    height: '100%',
    backgroundColor: '#FFFFFF',
  },
  door: {
    width: 11,
    height: 20,
    backgroundColor: '#9E8B7A',
    borderRadius: 1,
  },
  garage: {
    width: 30,
    height: 22,
    backgroundColor: '#E4E7EA',
    borderWidth: 1.5,
    justifyContent: 'space-evenly',
    paddingHorizontal: 2,
  },
  garageLine: {
    height: 1.5,
    backgroundColor: '#C3C9CF',
  },
  brick: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    height: 8,
  },
  treeWrap: {
    position: 'absolute',
    alignItems: 'center',
  },
  canopy: {
    // width/height/color are supplied inline per tree
  },
  trunk: {
    width: 6,
    backgroundColor: '#8A6A4F',
    borderRadius: 2,
  },
  shrub: {
    position: 'absolute',
    bottom: '18%',
    width: 14,
    height: 10,
    borderRadius: 7,
  },
});

export const PROPERTY_ART_FALLBACK_BG = colors.skySoft;
