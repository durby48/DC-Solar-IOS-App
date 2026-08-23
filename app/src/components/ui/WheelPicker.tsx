import { LinearGradient } from 'expo-linear-gradient';
import { useCallback, useEffect, useRef } from 'react';
import {
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  View,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
  type StyleProp,
  type ViewStyle,
} from 'react-native';

import { colors, radii, shadows, spacing } from '@/constants/theme';
import * as haptics from '@/lib/haptics';
import { useMotion } from '@/lib/motion';
import { AppText } from './AppText';
import { Button } from './Button';
import { Card } from './Card';

/**
 * The iOS-style scroll wheel, built from React Native primitives.
 *
 * WHY NOT `@react-native-picker/picker`. It is a native module, and adding a
 * native dependency to this app means a new EAS build before anybody can see
 * the change — the ship workflow here is OTA updates. Everything below is
 * `ScrollView` + `Pressable` + `expo-linear-gradient`, all of which are
 * already in the bundle, so a wheel ships in an `eas update`.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * HOW THE SNAP WORKS, AND WHY WEB NEEDS ITS OWN PATH
 * ─────────────────────────────────────────────────────────────────────────
 * On a phone, `snapToInterval` + `decelerationRate="fast"` do the physical
 * work and `onMomentumScrollEnd` tells us where it landed.
 *
 * react-native-web implements NEITHER. `snapToInterval` is dropped on the
 * floor (only `pagingEnabled` maps to CSS scroll-snap, and it snaps a whole
 * viewport, not a row), and `onMomentumScrollEnd` is never emitted — RNW's
 * `ScrollViewBase` only ever calls `onScroll`, plus one trailing `onScroll`
 * 100ms after the wheel stops. So on web we run our own settle timer and
 * snap the offset ourselves. Every row is also a `Pressable`, which is the
 * affordance a mouse actually wants and works identically on both platforms.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * STATE LIVES IN REFS ON PURPOSE
 * ─────────────────────────────────────────────────────────────────────────
 * `parked` (where the wheel physically sits) and `ticked` (the last row the
 * haptic fired for) are compared on every scroll frame. Making them state
 * would re-render the list 60 times a second, and the React Compiler cannot
 * cache a ref, so nothing here is at risk of being hoisted. The only render
 * input is the `value` prop.
 */

export interface WheelOption<T extends string = string> {
  value: T;
  label: string;
}

/** Row height. Also the snap interval, and comfortably over the 44pt target. */
const ITEM_H = 44;
/** How far the top/bottom fades reach into the wheel. */
const FADE_H = ITEM_H * 1.4;
/** Web only: quiet time after the last scroll event before we snap. */
const SETTLE_MS = 110;

const IS_WEB = Platform.OS === 'web';

// The fades have to end fully transparent, which no key in `gradients` does —
// every stop list in the theme is opaque on both ends because they are FILLS.
// These two are overlays, so they are spelled out here rather than adding a
// one-off key to the palette.
const CLEAR = 'rgba(255,255,255,0)';
const FADE_TOP = [colors.surface, CLEAR] as const;
const FADE_BOTTOM = [CLEAR, colors.surface] as const;
/** Ink at 45%, the same family as `gradients.scrimDown`. */
const SCRIM = 'rgba(61,53,46,0.45)';

/**
 * A vertical wheel of choices.
 *
 * Controlled: it renders whatever `value` says and calls `onChange` when the
 * wheel settles on a different row. `visibleRows` is forced odd (a wheel with
 * no middle row has nothing to highlight) and never below 3.
 */
export function WheelPicker<T extends string>({
  options,
  value,
  onChange,
  visibleRows = 5,
  style,
}: {
  options: readonly WheelOption<T>[];
  value: T;
  onChange: (value: T) => void;
  /** Rows shown at once. Forced odd; 5 is the iOS look. */
  visibleRows?: number;
  style?: StyleProp<ViewStyle>;
}) {
  const motion = useMotion();
  const scroller = useRef<ScrollView>(null);
  /** The row the wheel is physically sitting on. */
  const parked = useRef(-1);
  /** The row the last selection tick fired for. */
  const ticked = useRef(-1);
  const settleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const laidOut = useRef(false);

  const rows = Math.max(3, visibleRows % 2 === 0 ? visibleRows + 1 : visibleRows);
  const pad = (rows - 1) / 2;

  const found = options.findIndex((o) => o.value === value);
  const selectedIndex = found >= 0 ? found : 0;
  const last = Math.max(0, options.length - 1);

  const indexAt = useCallback(
    (offsetY: number) => Math.min(last, Math.max(0, Math.round(offsetY / ITEM_H))),
    [last],
  );

  /** Snap to the nearest row and report it. Idempotent — safe to re-run. */
  const settle = useCallback(
    (offsetY: number) => {
      const index = indexAt(offsetY);
      const target = index * ITEM_H;
      if (Math.abs(offsetY - target) > 0.5) {
        scroller.current?.scrollTo({ y: target, animated: false });
      }
      parked.current = index;
      ticked.current = index;
      const option = options[index];
      if (option && option.value !== value) onChange(option.value);
    },
    [indexAt, onChange, options, value],
  );

  const handleScroll = useCallback(
    (event: NativeSyntheticEvent<NativeScrollEvent>) => {
      const y = event.nativeEvent.contentOffset.y;
      const index = indexAt(y);
      // A tick as each row passes the band is what makes a wheel feel like a
      // wheel. Silent on web by design (see lib/haptics).
      if (index !== ticked.current) {
        ticked.current = index;
        haptics.tapLight();
      }
      if (!IS_WEB) return;
      if (settleTimer.current) clearTimeout(settleTimer.current);
      settleTimer.current = setTimeout(() => settle(y), SETTLE_MS);
    },
    [indexAt, settle],
  );

  const handleSettleEvent = useCallback(
    (event: NativeSyntheticEvent<NativeScrollEvent>) => {
      if (IS_WEB) return;
      settle(event.nativeEvent.contentOffset.y);
    },
    [settle],
  );

  // Follow the prop. Skipped when the wheel is already there, which is what
  // stops "user scrolls → onChange → value changes → scroll back" looping.
  useEffect(() => {
    if (parked.current === selectedIndex) return;
    parked.current = selectedIndex;
    ticked.current = selectedIndex;
    if (!laidOut.current) return;
    scroller.current?.scrollTo({ y: selectedIndex * ITEM_H, animated: motion.enabled });
  }, [selectedIndex, motion.enabled]);

  useEffect(
    () => () => {
      if (settleTimer.current) clearTimeout(settleTimer.current);
    },
    [],
  );

  const onLayout = useCallback(() => {
    if (laidOut.current) return;
    laidOut.current = true;
    // The first park has to be instant — an animated entrance from row 0
    // reads as the wheel spinning by itself.
    scroller.current?.scrollTo({ y: selectedIndex * ITEM_H, animated: false });
  }, [selectedIndex]);

  const pick = useCallback(
    (index: number) => {
      const option = options[index];
      if (!option) return;
      haptics.tapLight();
      parked.current = index;
      ticked.current = index;
      scroller.current?.scrollTo({ y: index * ITEM_H, animated: motion.enabled });
      if (option.value !== value) onChange(option.value);
    },
    [motion.enabled, onChange, options, value],
  );

  return (
    <View style={[styles.wheel, { height: ITEM_H * rows }, style]}>
      <Card tone="sunk" padded={false} style={[styles.band, { top: pad * ITEM_H }]} />

      <ScrollView
        ref={scroller}
        onLayout={onLayout}
        showsVerticalScrollIndicator={false}
        snapToInterval={ITEM_H}
        snapToAlignment="start"
        decelerationRate="fast"
        scrollEventThrottle={16}
        onScroll={handleScroll}
        onMomentumScrollEnd={handleSettleEvent}
        onScrollEndDrag={handleSettleEvent}
        contentContainerStyle={{ paddingVertical: pad * ITEM_H }}>
        {options.map((option, index) => {
          const selected = index === selectedIndex;
          return (
            <Pressable
              key={option.value}
              onPress={() => pick(index)}
              accessibilityRole="button"
              accessibilityState={{ selected }}
              accessibilityLabel={option.label}
              style={styles.row}>
              <AppText
                variant={selected ? 'bodyStrong' : 'body'}
                color={selected ? colors.textPrimary : colors.textMuted}
                align="center"
                numberOfLines={1}>
                {option.label}
              </AppText>
            </Pressable>
          );
        })}
      </ScrollView>

      <LinearGradient colors={FADE_TOP} style={[styles.fade, { top: 0, height: FADE_H }]} />
      <LinearGradient colors={FADE_BOTTOM} style={[styles.fade, { bottom: 0, height: FADE_H }]} />
    </View>
  );
}

/**
 * The wheel in a bottom sheet: dark scrim, title, Done.
 *
 * `onChange` fires live as the wheel settles rather than on Done, so the list
 * behind the sheet is already re-sorted when it closes — Done dismisses, it
 * does not commit. Tapping the scrim does the same thing.
 */
export function WheelPickerSheet<T extends string>({
  visible,
  title,
  options,
  value,
  onChange,
  onClose,
  visibleRows,
  doneLabel = 'Done',
}: {
  visible: boolean;
  title: string;
  options: readonly WheelOption<T>[];
  value: T;
  onChange: (value: T) => void;
  onClose: () => void;
  visibleRows?: number;
  doneLabel?: string;
}) {
  const motion = useMotion();
  return (
    <Modal
      visible={visible}
      transparent
      animationType={motion.enabled ? 'slide' : 'none'}
      statusBarTranslucent
      onRequestClose={onClose}>
      <View style={styles.scrimRoot}>
        <Pressable
          style={StyleSheet.absoluteFill}
          onPress={onClose}
          accessibilityRole="button"
          accessibilityLabel={`Close ${title}`}
        />
        <View style={styles.sheet}>
          <View style={styles.grip} />
          <AppText variant="heading" align="center">
            {title}
          </AppText>
          <WheelPicker
            options={options}
            value={value}
            onChange={onChange}
            visibleRows={visibleRows}
          />
          <Button label={doneLabel} onPress={onClose} fullWidth haptic="tapLight" />
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  wheel: {
    alignSelf: 'stretch',
    justifyContent: 'center',
    overflow: 'hidden',
  },
  band: {
    position: 'absolute',
    left: 0,
    right: 0,
    height: ITEM_H,
    borderRadius: radii.sm,
    // In `style`, not as a `pointerEvents` prop — RN 0.86 deprecated the prop
    // and warns once per render on the web.
    pointerEvents: 'none',
  },
  row: {
    height: ITEM_H,
    justifyContent: 'center',
    paddingHorizontal: spacing.md,
  },
  fade: {
    position: 'absolute',
    left: 0,
    right: 0,
    pointerEvents: 'none',
  },
  scrimRoot: {
    flex: 1,
    justifyContent: 'flex-end',
    backgroundColor: SCRIM,
  },
  sheet: {
    width: '100%',
    // The app is a phone app that also runs at desktop widths; a full-bleed
    // sheet on a 27" monitor is a mile of white.
    maxWidth: 520,
    alignSelf: 'center',
    backgroundColor: colors.surface,
    borderTopLeftRadius: radii.lg,
    borderTopRightRadius: radii.lg,
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.sm,
    paddingBottom: spacing.xl,
    gap: spacing.md,
    ...shadows.raised,
  },
  grip: {
    width: 44,
    height: 4,
    borderRadius: radii.pill,
    backgroundColor: colors.borderStrong,
    alignSelf: 'center',
    marginBottom: spacing.xs,
  },
});
