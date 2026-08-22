import Ionicons from '@expo/vector-icons/Ionicons';
import { Image } from 'expo-image';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  Modal,
  Platform,
  Pressable,
  StyleSheet,
  Switch,
  TextInput,
  View,
  useWindowDimensions,
} from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, {
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withSpring,
  withTiming,
} from 'react-native-reanimated';

import { AppText, Chip } from '@/components/ui';
import { colors, radii, spacing } from '@/constants/theme';
import * as haptics from '@/lib/haptics';
import {
  archiveMediaAsset,
  formatTimestamp,
  normalizeTags,
  updateMediaAsset,
} from '@/lib/media';
import { DURATION, EASE, SPRING, useMotion } from '@/lib/motion';
import { shareDocument } from '@/lib/pdf';

/**
 * The full-screen photo viewer.
 *
 * It replaces two different worse things at once: the Marketing panel had no
 * viewer at all, and `JobPhotos` opened a tap in the SYSTEM BROWSER — which on
 * a phone means leaving the app, watching a signed Supabase URL load in
 * Safari, and coming back with the screen you were on reloaded. A photo should
 * open where you tapped it.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * IT TAKES PLAIN ITEMS, NOT `MediaAsset`s
 * ─────────────────────────────────────────────────────────────────────────
 * `LightboxItem` is `{id, url, caption?}` plus optional extras. That is what
 * lets the same component serve the Dropbox library (where `assetId` is set
 * and admins can edit captions and tags) AND a job's own photos (where there
 * is no `media_assets` row and the edit affordances simply are not drawn).
 * Use `assetToLightboxItem()` for the library side.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * GESTURES
 * ─────────────────────────────────────────────────────────────────────────
 * Pinch and pan are `react-native-gesture-handler` gestures driving Reanimated
 * shared values — no `.value` is ever read during render (see `lib/motion.ts`
 * for why that matters with the React Compiler on).
 *
 *   pinch        — `Gesture.Pinch()`, clamped to 1–4×. Anchored on the focal
 *                  point so the picture zooms toward the fingers rather than
 *                  toward the middle of the screen.
 *   pan (zoomed) — drags the picture, clamped to its own edges so it can never
 *                  be flung into empty space.
 *   pan (not)    — swipe DOWN to dismiss: the page follows the finger, the
 *                  scrim fades, and past 110px it closes. `failOffsetX` keeps
 *                  it out of the pager's way.
 *   double tap   — toggles 1× / 2×. This is the one that matters on the web.
 *   single tap   — hides/shows the chrome, so a photo can be looked at.
 *
 * Paging is a horizontal `FlatList` with `pagingEnabled`, and its
 * `scrollEnabled` is turned OFF while a page is zoomed — otherwise dragging a
 * zoomed photo sideways flicks to the next one instead of panning. Zoom resets
 * when a page stops being the active one.
 *
 * WEB FALLBACK, AND WHY IT IS NOT `maximumZoomScale`. React Native's
 * `ScrollView maximumZoomScale` is iOS-only — on react-native-web it is
 * inert, so "fall back to a zooming ScrollView" would have shipped a control
 * that does nothing in the browser. Instead the web build gets an explicit
 * zoom button next to the close button, and double-CLICK toggles 2× exactly
 * like double-tap does on a phone. Pinch is still attached on web (RNGH does
 * translate trackpad and multi-touch pinches) — it is simply not the only way
 * in. Nothing about the feature depends on it working.
 *
 * Reduced motion: `useMotion()` gates every spring and the modal's own
 * animation. Zoom still happens — it just arrives instead of travelling.
 */

export interface LightboxItem {
  id: string;
  /** Signed display URL. */
  url: string;
  caption?: string | null;
  tags?: string[];
  takenAt?: string | null;
  featured?: boolean;
  /** Used to name the shared file. */
  fileName?: string | null;
  /**
   * `media_assets` row id. Present for library photos only — without it the
   * edit sheet is not offered, because there is nothing to write to.
   */
  assetId?: string | null;
}

const MIN_SCALE = 1;
const MAX_SCALE = 4;
const DOUBLE_TAP_SCALE = 2;
/** How far a downward swipe has to travel before it closes the viewer. */
const DISMISS_DISTANCE = 110;

/** `MediaAsset` + its signed URL → a viewer item. */
export function assetToLightboxItem(
  asset: {
    id: string;
    caption: string | null;
    tags: string[];
    takenAt: string | null;
    featured: boolean;
    fileName: string | null;
  },
  url: string,
): LightboxItem {
  return {
    id: asset.id,
    url,
    caption: asset.caption,
    tags: asset.tags,
    takenAt: asset.takenAt,
    featured: asset.featured,
    fileName: asset.fileName,
    assetId: asset.id,
  };
}

// ---------------------------------------------------------------------------
// One zoomable page
// ---------------------------------------------------------------------------

function ZoomablePage({
  item,
  width,
  height,
  active,
  zoomed,
  onZoomedChange,
  onToggleChrome,
  onDismiss,
}: {
  item: LightboxItem;
  width: number;
  height: number;
  /** True for the page currently on screen. Inactive pages reset their zoom. */
  active: boolean;
  zoomed: boolean;
  onZoomedChange: (value: boolean) => void;
  onToggleChrome: () => void;
  onDismiss: () => void;
}) {
  const { enabled: animate } = useMotion();
  /**
   * Durations as NUMBERS, resolved on the JS side.
   *
   * `useMotion().ms()` is a plain JS function. Calling it from inside a
   * `'worklet'` would try to run it synchronously on the UI runtime and throw
   * on a device — it only appeared to work in the browser because Reanimated
   * runs worklets on the JS thread there. Everything a worklet below captures
   * is a primitive for this reason.
   */
  const baseMs = animate ? DURATION.base : 0;

  const scale = useSharedValue(1);
  const savedScale = useSharedValue(1);
  const translateX = useSharedValue(0);
  const translateY = useSharedValue(0);
  const savedX = useSharedValue(0);
  const savedY = useSharedValue(0);
  const dismissY = useSharedValue(0);
  const [failed, setFailed] = useState(false);

  const setZoomed = useCallback(
    (value: boolean) => {
      onZoomedChange(value);
    },
    [onZoomedChange],
  );

  const reset = useCallback(
    (ms: number) => {
      scale.value = withTiming(1, { duration: ms, easing: EASE.out });
      savedScale.value = 1;
      translateX.value = withTiming(0, { duration: ms, easing: EASE.out });
      translateY.value = withTiming(0, { duration: ms, easing: EASE.out });
      savedX.value = 0;
      savedY.value = 0;
      dismissY.value = withTiming(0, { duration: ms, easing: EASE.out });
      setZoomed(false);
    },
    [scale, savedScale, translateX, translateY, savedX, savedY, dismissY, setZoomed],
  );

  // Swiping to the next photo must not leave the one behind you zoomed in.
  // Keyed on `active` ALONE on purpose: re-running this whenever `reset`
  // changed identity would fire it on every render of the pager.
  useEffect(() => {
    if (!active) reset(0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);

  const zoomTo = useCallback(
    (next: number) => {
      const target = Math.min(MAX_SCALE, Math.max(MIN_SCALE, next));
      scale.value = withTiming(target, { duration: baseMs, easing: EASE.standard });
      savedScale.value = target;
      if (target <= 1) {
        translateX.value = withTiming(0, { duration: baseMs, easing: EASE.standard });
        translateY.value = withTiming(0, { duration: baseMs, easing: EASE.standard });
        savedX.value = 0;
        savedY.value = 0;
      }
      setZoomed(target > 1);
    },
    [baseMs, scale, savedScale, translateX, translateY, savedX, savedY, setZoomed],
  );

  const gesture = useMemo(() => {
    const pinch = Gesture.Pinch()
      .onUpdate((event) => {
        'worklet';
        const next = savedScale.value * event.scale;
        scale.value = Math.min(MAX_SCALE, Math.max(0.6, next));
      })
      .onEnd(() => {
        'worklet';
        // Under 1× it springs back rather than staying shrunk — a pinch-in on
        // an un-zoomed photo should feel like a rubber band, not a setting.
        const settled = Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale.value));
        scale.value = animate
          ? withSpring(settled, SPRING.gentle)
          : withTiming(settled, { duration: 0 });
        savedScale.value = settled;
        if (settled <= MIN_SCALE) {
          translateX.value = animate ? withSpring(0, SPRING.gentle) : withTiming(0, { duration: 0 });
          translateY.value = animate ? withSpring(0, SPRING.gentle) : withTiming(0, { duration: 0 });
          savedX.value = 0;
          savedY.value = 0;
        }
        runOnJS(setZoomed)(settled > MIN_SCALE);
      });

    // Zoomed: drag the picture, clamped so its edges can never leave the frame.
    const panZoom = Gesture.Pan()
      .enabled(zoomed)
      .onUpdate((event) => {
        'worklet';
        const limitX = (width * (scale.value - 1)) / 2;
        const limitY = (height * (scale.value - 1)) / 2;
        translateX.value = Math.min(limitX, Math.max(-limitX, savedX.value + event.translationX));
        translateY.value = Math.min(limitY, Math.max(-limitY, savedY.value + event.translationY));
      })
      .onEnd(() => {
        'worklet';
        savedX.value = translateX.value;
        savedY.value = translateY.value;
      });

    // Not zoomed: swipe down to dismiss. `failOffsetX` hands horizontal
    // movement back to the pager instead of fighting it.
    const panDismiss = Gesture.Pan()
      .enabled(!zoomed)
      .activeOffsetY([-20, 20])
      .failOffsetX([-25, 25])
      .onUpdate((event) => {
        'worklet';
        dismissY.value = event.translationY;
      })
      .onEnd((event) => {
        'worklet';
        if (event.translationY > DISMISS_DISTANCE) {
          runOnJS(onDismiss)();
          dismissY.value = withTiming(0, { duration: 0 });
          return;
        }
        dismissY.value = animate
          ? withSpring(0, SPRING.gentle)
          : withTiming(0, { duration: 0 });
      });

    const doubleTap = Gesture.Tap()
      .numberOfTaps(2)
      .maxDelay(260)
      .onEnd((event) => {
        'worklet';
        const goingIn = scale.value <= MIN_SCALE + 0.01;
        if (goingIn) {
          // Zoom toward the point that was tapped, not the middle of the frame.
          const focalX = event.x - width / 2;
          const focalY = event.y - height / 2;
          const limitX = (width * (DOUBLE_TAP_SCALE - 1)) / 2;
          const limitY = (height * (DOUBLE_TAP_SCALE - 1)) / 2;
          const nextX = Math.min(limitX, Math.max(-limitX, -focalX));
          const nextY = Math.min(limitY, Math.max(-limitY, -focalY));
          translateX.value = withTiming(nextX, { duration: baseMs, easing: EASE.standard });
          translateY.value = withTiming(nextY, { duration: baseMs, easing: EASE.standard });
          savedX.value = nextX;
          savedY.value = nextY;
        } else {
          translateX.value = withTiming(0, { duration: baseMs, easing: EASE.standard });
          translateY.value = withTiming(0, { duration: baseMs, easing: EASE.standard });
          savedX.value = 0;
          savedY.value = 0;
        }
        const target = goingIn ? DOUBLE_TAP_SCALE : MIN_SCALE;
        scale.value = withTiming(target, { duration: baseMs, easing: EASE.standard });
        savedScale.value = target;
        runOnJS(setZoomed)(goingIn);
      });

    const singleTap = Gesture.Tap()
      .numberOfTaps(1)
      .onEnd(() => {
        'worklet';
        runOnJS(onToggleChrome)();
      });

    return Gesture.Race(
      Gesture.Simultaneous(pinch, panZoom, panDismiss),
      Gesture.Exclusive(doubleTap, singleTap),
    );
  }, [
    zoomed,
    width,
    height,
    animate,
    baseMs,
    scale,
    savedScale,
    translateX,
    translateY,
    savedX,
    savedY,
    dismissY,
    setZoomed,
    onToggleChrome,
    onDismiss,
  ]);

  const imageStyle = useAnimatedStyle(() => ({
    transform: [
      { translateX: translateX.value },
      { translateY: translateY.value + dismissY.value },
      { scale: scale.value },
    ],
    opacity: 1 - Math.min(0.6, Math.abs(dismissY.value) / 400),
  }));

  return (
    <View style={{ width, height }}>
      <GestureDetector gesture={gesture}>
        <Animated.View style={[styles.pageInner, imageStyle]}>
          {failed ? (
            <View style={styles.pageMessage}>
              <Ionicons name="image-outline" size={30} color={colors.textOnDark} />
              <AppText variant="caption" color={colors.textOnDark}>
                This photo could not be loaded.
              </AppText>
            </View>
          ) : (
            <Image
              source={{ uri: item.url }}
              style={styles.image}
              contentFit="contain"
              transition={150}
              cachePolicy="memory-disk"
              onError={() => setFailed(true)}
              accessibilityLabel={item.caption ?? 'Photo'}
            />
          )}
        </Animated.View>
      </GestureDetector>

      {/* Web has no pinch on a plain mouse. This, and double-click, are the
          two ways in that always work in a browser. */}
      {Platform.OS === 'web' ? (
        <Pressable
          onPress={() => zoomTo(zoomed ? MIN_SCALE : DOUBLE_TAP_SCALE)}
          accessibilityRole="button"
          accessibilityLabel={zoomed ? 'Zoom out' : 'Zoom in'}
          style={({ pressed }) => [styles.zoomButton, pressed && styles.dimmed]}>
          <Ionicons
            name={zoomed ? 'contract-outline' : 'expand-outline'}
            size={20}
            color={colors.textOnDark}
          />
        </Pressable>
      ) : null}
    </View>
  );
}

// ---------------------------------------------------------------------------
// The viewer
// ---------------------------------------------------------------------------

export function MediaLightbox({
  items,
  index,
  visible,
  onClose,
  onIndexChange,
  canEdit = false,
  onChanged,
}: {
  items: LightboxItem[];
  /** Which photo to open on. */
  index: number;
  visible: boolean;
  onClose: () => void;
  onIndexChange?: (next: number) => void;
  /** Draw the admin edit affordances. RLS is the real barrier either way. */
  canEdit?: boolean;
  /** Called after a successful caption/tag/featured/archive change. */
  onChanged?: () => void;
}) {
  const motion = useMotion();
  const { width, height } = useWindowDimensions();
  const listRef = useRef<FlatList<LightboxItem>>(null);
  const [current, setCurrent] = useState(index);
  const [zoomed, setZoomed] = useState(false);
  const [chrome, setChrome] = useState(true);
  const [sharing, setSharing] = useState(false);
  const [editing, setEditing] = useState(false);
  const [caption, setCaption] = useState('');
  const [tagText, setTagText] = useState('');
  const [featured, setFeatured] = useState(false);
  const [saving, setSaving] = useState(false);
  const [confirmArchive, setConfirmArchive] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  const item = items[current] ?? items[0] ?? null;

  // Re-open on whichever thumbnail was tapped, and forget any previous state.
  useEffect(() => {
    if (!visible) return;
    setCurrent(index);
    setZoomed(false);
    setChrome(true);
    setEditing(false);
    setConfirmArchive(false);
    setNote(null);
  }, [visible, index]);

  const toggleChrome = useCallback(() => setChrome((on) => !on), []);

  const handleMomentumEnd = useCallback(
    (event: { nativeEvent: { contentOffset: { x: number } } }) => {
      const next = Math.round(event.nativeEvent.contentOffset.x / Math.max(1, width));
      if (next === current) return;
      setCurrent(next);
      setZoomed(false);
      setConfirmArchive(false);
      setEditing(false);
      onIndexChange?.(next);
    },
    [current, width, onIndexChange],
  );

  const share = useCallback(async () => {
    if (!item) return;
    setSharing(true);
    haptics.tapMedium();
    const name = item.fileName?.trim() || `photo-${item.id}.jpg`;
    const ok = await shareDocument(item.url, name);
    setSharing(false);
    if (!ok) setNote('Sharing is not available on this device.');
  }, [item]);

  const openEditor = useCallback(() => {
    if (!item) return;
    setCaption(item.caption ?? '');
    setTagText((item.tags ?? []).join(', '));
    setFeatured(item.featured === true);
    setConfirmArchive(false);
    setNote(null);
    setEditing(true);
    setChrome(true);
  }, [item]);

  const saveEdit = useCallback(async () => {
    if (!item?.assetId) return;
    setSaving(true);
    const result = await updateMediaAsset(item.assetId, {
      caption,
      tags: normalizeTags(tagText),
      featured,
    });
    setSaving(false);
    if (result.ok) {
      haptics.success();
      setEditing(false);
      setNote('Saved.');
      onChanged?.();
    } else {
      haptics.error();
      setNote(result.message);
    }
  }, [item, caption, tagText, featured, onChanged]);

  const archive = useCallback(async () => {
    if (!item?.assetId) return;
    if (!confirmArchive) {
      setConfirmArchive(true);
      haptics.warn();
      return;
    }
    setConfirmArchive(false);
    setSaving(true);
    const result = await archiveMediaAsset(item.assetId);
    setSaving(false);
    if (result.ok) {
      haptics.success();
      setEditing(false);
      onChanged?.();
      onClose();
    } else {
      haptics.error();
      setNote(result.message);
    }
  }, [item, confirmArchive, onChanged, onClose]);

  if (!visible || items.length === 0) return null;

  const tags = item?.tags ?? [];
  const showEdit = canEdit && Boolean(item?.assetId);

  return (
    <Modal
      visible={visible}
      transparent={false}
      animationType={motion.enabled ? 'fade' : 'none'}
      statusBarTranslucent
      supportedOrientations={['portrait', 'landscape']}
      onRequestClose={onClose}>
      <View style={styles.scrim}>
        <FlatList
          ref={listRef}
          data={items}
          keyExtractor={(entry) => entry.id}
          horizontal
          pagingEnabled
          scrollEnabled={!zoomed}
          showsHorizontalScrollIndicator={false}
          initialScrollIndex={Math.min(Math.max(0, index), items.length - 1)}
          getItemLayout={(_, i) => ({ length: width, offset: width * i, index: i })}
          onMomentumScrollEnd={handleMomentumEnd}
          renderItem={({ item: entry, index: i }) => (
            <ZoomablePage
              item={entry}
              width={width}
              height={height}
              active={i === current}
              zoomed={i === current && zoomed}
              onZoomedChange={setZoomed}
              onToggleChrome={toggleChrome}
              onDismiss={onClose}
            />
          )}
        />

        {chrome ? (
          <>
            <View style={styles.topBar} pointerEvents="box-none">
              <Pressable
                onPress={onClose}
                hitSlop={10}
                accessibilityRole="button"
                accessibilityLabel="Close"
                style={({ pressed }) => [styles.roundButton, pressed && styles.dimmed]}>
                <Ionicons name="close" size={22} color={colors.textOnDark} />
              </Pressable>

              <View style={styles.topRight}>
                {items.length > 1 ? (
                  <View style={styles.counter}>
                    <AppText variant="caption" color={colors.textOnDark}>
                      {`${current + 1} / ${items.length}`}
                    </AppText>
                  </View>
                ) : null}
                {showEdit ? (
                  <Pressable
                    onPress={openEditor}
                    hitSlop={10}
                    accessibilityRole="button"
                    accessibilityLabel="Edit photo details"
                    style={({ pressed }) => [styles.roundButton, pressed && styles.dimmed]}>
                    <Ionicons name="create-outline" size={20} color={colors.textOnDark} />
                  </Pressable>
                ) : null}
                <Pressable
                  onPress={share}
                  disabled={sharing}
                  hitSlop={10}
                  accessibilityRole="button"
                  accessibilityLabel="Share photo"
                  style={({ pressed }) => [styles.roundButton, pressed && styles.dimmed]}>
                  {sharing ? (
                    <ActivityIndicator size="small" color={colors.textOnDark} />
                  ) : (
                    <Ionicons name="share-outline" size={20} color={colors.textOnDark} />
                  )}
                </Pressable>
              </View>
            </View>

            {!editing ? (
              <View style={styles.bottomBar} pointerEvents="box-none">
                {item?.caption ? (
                  <AppText variant="body" color={colors.textOnDark}>
                    {item.caption}
                  </AppText>
                ) : null}
                {formatTimestamp(item?.takenAt) ? (
                  <AppText variant="caption" color={colors.textOnDark} style={styles.faint}>
                    {formatTimestamp(item?.takenAt)}
                  </AppText>
                ) : null}
                {tags.length > 0 ? (
                  <View style={styles.tagRow}>
                    {tags.map((tag) => (
                      <Chip key={tag} label={tag} tone="ocean" />
                    ))}
                  </View>
                ) : null}
                {note ? (
                  <AppText variant="caption" color={colors.textOnDark}>
                    {note}
                  </AppText>
                ) : null}
              </View>
            ) : null}
          </>
        ) : null}

        {editing && showEdit ? (
          <View style={styles.sheet}>
            <View style={styles.sheetHeader}>
              <AppText variant="heading">Photo details</AppText>
              <Pressable onPress={() => setEditing(false)} hitSlop={10}>
                <Ionicons name="close" size={20} color={colors.textSecondary} />
              </Pressable>
            </View>

            <AppText variant="section" color={colors.textSecondary}>
              Caption
            </AppText>
            <TextInput
              value={caption}
              onChangeText={setCaption}
              placeholder="What is this a photo of?"
              placeholderTextColor={colors.textMuted}
              multiline
              style={styles.input}
            />

            <AppText variant="section" color={colors.textSecondary}>
              Tags
            </AppText>
            <TextInput
              value={tagText}
              onChangeText={setTagText}
              placeholder="roof, before, overland park"
              placeholderTextColor={colors.textMuted}
              autoCapitalize="none"
              autoCorrect={false}
              style={styles.input}
            />
            {normalizeTags(tagText).length > 0 ? (
              <View style={styles.tagRow}>
                {normalizeTags(tagText).map((tag) => (
                  <Chip key={tag} label={tag} tone="olive" />
                ))}
              </View>
            ) : (
              <AppText variant="caption" color={colors.textMuted}>
                Separate tags with commas.
              </AppText>
            )}

            <View style={styles.switchRow}>
              <AppText variant="bodyStrong">Featured</AppText>
              <Switch
                value={featured}
                onValueChange={setFeatured}
                trackColor={{ true: colors.accentPrimary, false: colors.border }}
              />
            </View>

            {note ? (
              <AppText variant="caption" color={colors.danger}>
                {note}
              </AppText>
            ) : null}

            <View style={styles.sheetActions}>
              <Pressable
                onPress={archive}
                disabled={saving}
                accessibilityRole="button"
                style={({ pressed }) => [
                  styles.archiveButton,
                  confirmArchive && styles.archiveButtonArmed,
                  pressed && styles.dimmed,
                ]}>
                <AppText
                  variant="button"
                  color={confirmArchive ? colors.white : colors.danger}>
                  {confirmArchive ? 'Tap again to archive' : 'Archive'}
                </AppText>
              </Pressable>
              <Pressable
                onPress={saveEdit}
                disabled={saving}
                accessibilityRole="button"
                style={({ pressed }) => [styles.saveButton, pressed && styles.dimmed]}>
                {saving ? (
                  <ActivityIndicator size="small" color={colors.ink} />
                ) : (
                  <AppText variant="button" color={colors.ink}>
                    Save
                  </AppText>
                )}
              </Pressable>
            </View>

            <AppText variant="caption" color={colors.textMuted}>
              Archiving hides the photo everywhere in the app. The file itself is
              never deleted.
            </AppText>
          </View>
        ) : null}
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  scrim: {
    flex: 1,
    backgroundColor: '#0B0B0D',
  },
  pageInner: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  image: {
    width: '100%',
    height: '100%',
  },
  pageMessage: {
    alignItems: 'center',
    gap: spacing.sm,
  },
  topBar: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.sm,
    paddingHorizontal: spacing.md,
    paddingTop: spacing.xl + spacing.sm,
    paddingBottom: spacing.md,
    backgroundColor: 'rgba(0,0,0,0.35)',
  },
  topRight: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
  },
  counter: {
    paddingHorizontal: spacing.sm,
  },
  roundButton: {
    width: 40,
    height: 40,
    borderRadius: radii.pill,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(255,255,255,0.14)',
  },
  zoomButton: {
    position: 'absolute',
    right: spacing.md,
    bottom: spacing.xl * 2,
    width: 40,
    height: 40,
    borderRadius: radii.pill,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(255,255,255,0.14)',
  },
  dimmed: {
    opacity: 0.6,
  },
  bottomBar: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    gap: spacing.xs,
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.md,
    paddingBottom: spacing.xl,
    backgroundColor: 'rgba(0,0,0,0.45)',
  },
  faint: {
    opacity: 0.75,
  },
  tagRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.xs,
  },
  sheet: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    gap: spacing.sm,
    padding: spacing.lg,
    paddingBottom: spacing.xl,
    backgroundColor: colors.surface,
    borderTopLeftRadius: radii.lg,
    borderTopRightRadius: radii.lg,
  },
  sheetHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  input: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radii.sm,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.sm,
    color: colors.textPrimary,
    fontSize: 15,
    minHeight: 44,
    textAlignVertical: 'top',
  },
  switchRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: spacing.xs,
  },
  sheetActions: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.md,
    marginTop: spacing.xs,
  },
  archiveButton: {
    borderRadius: radii.pill,
    borderWidth: 1,
    borderColor: colors.danger,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm + 2,
  },
  archiveButtonArmed: {
    backgroundColor: colors.danger,
    borderColor: colors.danger,
  },
  saveButton: {
    flex: 1,
    alignItems: 'center',
    borderRadius: radii.pill,
    backgroundColor: colors.accentAction,
    paddingVertical: spacing.sm + 2,
  },
});
