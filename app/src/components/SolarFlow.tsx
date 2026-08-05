import { useEffect, useMemo, useRef, useState } from 'react';
import {
  AccessibilityInfo,
  Animated,
  Easing,
  Platform,
  StyleSheet,
  View,
  useWindowDimensions,
} from 'react-native';

/**
 * "Solar Flow" — a grid of light particles with a wave of brightness
 * travelling through it, layered over the login backdrop.
 *
 * Cost control is the whole design. A per-particle animation on a 10×18 grid
 * would mean 180 driven values; instead ONE looping driver feeds a per-ROW
 * interpolation (18 of them), and every particle in a row shares its row's
 * phase. Columns get a fixed brightness offset so the crest still reads as a
 * diagonal sweep rather than a flat bar marching down the screen.
 *
 * Runs on the native thread (opacity + translateY only). Under "reduce motion"
 * the grid still renders, frozen at a pleasing point in the wave — that
 * setting asks for less MOTION, not less decoration, and blanking the layer
 * entirely lost the texture for no benefit.
 *
 * No new dependencies: this is plain `Animated`, because a shader or SVG
 * library would force a full App Store build.
 */

const ROWS = 18;
const COLS = 10;
/** Keyframes per row — more is smoother, and costs nothing at runtime. */
const STEPS = 24;
/** Seconds for one full pass of the wave. */
const PERIOD_MS = 7000;

function buildWave(phase: number): { input: number[]; output: number[] } {
  const input: number[] = [];
  const output: number[] = [];
  for (let i = 0; i <= STEPS; i++) {
    const x = i / STEPS;
    input.push(x);
    // A travelling crest: mostly dim, with a soft bright pulse passing through.
    const wave = Math.sin(2 * Math.PI * (x + phase));
    output.push(0.12 + 0.88 * Math.pow(Math.max(0, wave), 3));
  }
  return { input, output };
}

export function SolarFlow() {
  const { width, height } = useWindowDimensions();
  const [reduceMotion, setReduceMotion] = useState(false);
  const driver = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    let cancelled = false;
    AccessibilityInfo.isReduceMotionEnabled?.()
      .then((on) => {
        if (!cancelled) setReduceMotion(Boolean(on));
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (reduceMotion) return;
    driver.setValue(0);
    const animation = Animated.loop(
      Animated.timing(driver, {
        toValue: 1,
        duration: PERIOD_MS,
        easing: Easing.linear,
        useNativeDriver: Platform.OS !== 'web',
      }),
    );
    animation.start();
    return () => animation.stop();
  }, [driver, reduceMotion]);

  const rows = useMemo(
    () =>
      Array.from({ length: ROWS }, (_, r) => {
        const { input, output } = buildWave(r / ROWS);
        return {
          key: r,
          top: ((r + 0.5) / ROWS) * height,
          // Static value used when motion is reduced: the wave held still.
          frozen: output[Math.floor(STEPS * 0.25)],
          opacity: driver.interpolate({ inputRange: input, outputRange: output }),
          // A few pixels of lift on the crest — reads as the grid breathing.
          translateY: driver.interpolate({
            inputRange: input,
            outputRange: output.map((v) => -v * 5),
          }),
        };
      }),
    [driver, height],
  );

  return (
    <View style={StyleSheet.absoluteFill} pointerEvents="none">
      {rows.map((row) => (
        <Animated.View
          key={row.key}
          style={[
            styles.row,
            reduceMotion
              ? { top: row.top, opacity: row.frozen }
              : {
                  top: row.top,
                  opacity: row.opacity,
                  transform: [{ translateY: row.translateY }],
                },
          ]}>
          {Array.from({ length: COLS }, (_, c) => (
            <View
              key={c}
              style={[
                styles.dot,
                {
                  left: ((c + 0.5) / COLS) * width,
                  // Static per-column falloff tilts the crest into a diagonal
                  // and keeps the right side cooler, matching the backdrop.
                  opacity: 0.35 + 0.65 * (1 - c / COLS),
                },
              ]}
            />
          ))}
        </Animated.View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    position: 'absolute',
    left: 0,
    right: 0,
    height: 3,
  },
  dot: {
    position: 'absolute',
    width: 3,
    height: 3,
    borderRadius: 1.5,
    backgroundColor: '#FFC876',
  },
});
