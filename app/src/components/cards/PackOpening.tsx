import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Modal,
  ScrollView,
  StyleSheet,
  useWindowDimensions,
  View,
} from 'react-native';
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withTiming,
} from 'react-native-reanimated';

import { AppText, Button, Confetti } from '@/components/ui';
import { colors, radii, spacing } from '@/constants/theme';
import {
  effectiveVariant,
  fetchCardArtUrls,
  isHitRarity,
  openPack,
  rarityLabel,
  variantLabel,
  type CardRecord,
  type PackResult,
} from '@/lib/cards';
import { haptics } from '@/lib/haptics';
import { DURATION, EASE, useMotion } from '@/lib/motion';
import { FlipCard } from './FlipCard';
import { TradingCard } from './TradingCard';

/**
 * "Open a pack" — seven cards, dealt by the server, turned over one at a time.
 *
 * ────────────────────────────────────────────────────────────────────────
 * THE SERVER DEALS. THIS FILE IS THEATRE.
 * ────────────────────────────────────────────────────────────────────────
 * The previous version of this component rolled its own rarities off a weight
 * table and saved nothing — a five-second bit of fun over a set everybody
 * could already see in full. It isn't that any more. A pack is EARNED (one
 * per ten hours worked, backdated over every hour on the books) and SPENT:
 * `open_card_pack` picks the seven cards, fills the rarity slots, rolls the
 * foil/holo finishes and banks the copies, all inside one transaction. There
 * is no `Math.random()` in this file and there must never be one, because a
 * client that can deal itself a secret rare is a client that will.
 *
 * What this file owns is the two seconds after that: the order the cards turn
 * over, when the hit lands, and what it feels like when it does.
 *
 *   • Slots 1→7 in the order the server numbered them. Slot 7 is the hit and
 *     gets a deliberate pause in front of it — the beat before the reveal is
 *     most of what a booster pack is actually selling.
 *   • A light tick per flip, a success buzz and confetti only for a real hit.
 *   • NEW on a card that wasn't in this deck before. Duplicates are normal
 *     and are not apologised for; they're how you end up with a foil one.
 *
 * REDUCED MOTION: everything is face-up immediately, no stagger, no confetti,
 * no shimmer. The person still gets their cards, they just don't get a show.
 */

/** Gap between one card turning over and the next. */
const REVEAL_STAGGER = 380;
/** The beat before the last card. Slot 7 is the hit; make them wait for it. */
const HIT_PAUSE = 800;

export function PackOpening({ onClose }: { onClose: () => void }) {
  const motion = useMotion();
  const { width } = useWindowDimensions();
  const scroller = useRef<ScrollView | null>(null);

  const [phase, setPhase] = useState<'opening' | 'cards' | 'error'>('opening');
  const [pack, setPack] = useState<PackResult[]>([]);
  const [artUrls, setArtUrls] = useState<Map<string, string>>(new Map());
  const [failure, setFailure] = useState<{ code: 'no_packs' | 'unavailable'; message: string } | null>(
    null,
  );
  const [revealed, setRevealed] = useState(0);
  const [confetti, setConfetti] = useState(false);

  const cardWidth = Math.min(180, Math.max(118, (width - spacing.lg * 2) * 0.46));
  const cardHeight = cardWidth * 1.4;
  const slotWidth = cardWidth + spacing.sm;

  // --- ask the server -------------------------------------------------------
  // Exactly once per mount. The screen unmounts this component to close, so a
  // second pack means a second mount — there is no "open another" button by
  // design, because packs are a finite thing somebody earned.
  useEffect(() => {
    let cancelled = false;
    const run = async () => {
      const result = await openPack();
      if (cancelled) return;
      if (!result.ok) {
        setFailure({ code: result.code, message: result.message });
        setPhase('error');
        haptics.warn();
        return;
      }
      setPack(result.cards);
      setPhase('cards');

      const cards = result.cards
        .map((pull) => pull.card)
        .filter((card): card is CardRecord => card != null);
      const urls = await fetchCardArtUrls(cards);
      if (!cancelled) setArtUrls(urls);
    };
    void run();
    return () => {
      cancelled = true;
    };
  }, []);

  // --- the reveal -----------------------------------------------------------
  useEffect(() => {
    if (phase !== 'cards' || pack.length === 0) return;
    if (!motion.enabled) {
      setRevealed(pack.length);
      return;
    }
    const last = pack.length - 1;
    const timers = pack.map((_, index) =>
      setTimeout(
        () => {
          setRevealed((current) => Math.max(current, index + 1));
          haptics.tapLight();
        },
        DURATION.base + index * REVEAL_STAGGER + (index === last ? HIT_PAUSE : 0),
      ),
    );
    return () => {
      timers.forEach(clearTimeout);
    };
  }, [phase, pack, motion.enabled]);

  /**
   * Keep the card that is turning over on screen. Seven cards do not fit on a
   * phone, and a reveal you have to scroll to find is not a reveal.
   */
  useEffect(() => {
    if (revealed < 1 || !motion.enabled) return;
    const index = revealed - 1;
    const target = Math.max(0, index * slotWidth - (width - slotWidth) / 2);
    scroller.current?.scrollTo({ x: target, animated: true });
  }, [revealed, slotWidth, width, motion.enabled]);

  const hit = useMemo(() => pack[pack.length - 1] ?? null, [pack]);
  const celebrate = useMemo(() => {
    const hitRarity = hit?.card?.rarity;
    if (hitRarity && isHitRarity(hitRarity)) return true;
    // A legendary that is new to this deck counts even out of the hit slot.
    return pack.some((pull) => pull.isNew && pull.card?.rarity === 'legendary');
  }, [pack, hit]);

  const complete = phase === 'cards' && pack.length > 0 && revealed >= pack.length;

  useEffect(() => {
    if (!complete || !celebrate) return;
    haptics.success();
    if (motion.enabled) setConfetti(true);
  }, [complete, celebrate, motion.enabled]);

  const revealAll = useCallback(() => {
    setRevealed(pack.length);
  }, [pack.length]);

  const newCount = pack.filter((pull) => pull.isNew).length;

  return (
    <Modal visible transparent animationType="fade" onRequestClose={onClose}>
      <View style={styles.backdrop}>
        <View style={styles.sheet}>
          {phase === 'opening' ? (
            <View style={styles.center}>
              <ActivityIndicator color={colors.sun} />
              <AppText variant="title" color={colors.textOnDark} align="center">
                Tearing it open…
              </AppText>
            </View>
          ) : phase === 'error' ? (
            <View style={styles.center}>
              <AppText variant="title" color={colors.textOnDark} align="center">
                {failure?.code === 'no_packs' ? 'No packs yet' : "That didn't work"}
              </AppText>
              <AppText variant="body" color={colors.oliveSoft} align="center">
                {failure?.message ?? 'The pack could not be opened.'}
              </AppText>
              <Button label="Close" variant="onDark" onPress={onClose} />
            </View>
          ) : (
            <>
              <AppText variant="title" color={colors.textOnDark} align="center">
                {!complete
                  ? 'Opening…'
                  : celebrate
                    ? 'Well look at that.'
                    : newCount > 0
                      ? `${newCount} new for the deck`
                      : 'Your pack'}
              </AppText>
              <AppText variant="caption" color={colors.oliveSoft} align="center">
                Seven cards · four common, two uncommon, one hit
              </AppText>

              <ScrollView
                ref={scroller}
                horizontal
                showsHorizontalScrollIndicator={false}
                contentContainerStyle={styles.row}>
                {pack.map((pull, index) => (
                  <Slot
                    key={pull.userCardId || `${pull.cardId}-${pull.slot}`}
                    pull={pull}
                    artUrl={pull.card ? (artUrls.get(pull.card.id) ?? null) : null}
                    width={cardWidth}
                    height={cardHeight}
                    revealed={index < revealed}
                    shimmer={motion.enabled}
                  />
                ))}
              </ScrollView>

              <View style={styles.actions}>
                {complete ? (
                  <Button
                    label="Add to deck"
                    icon="albums-outline"
                    variant="primary"
                    onPress={onClose}
                  />
                ) : (
                  <Button
                    label="Reveal all"
                    variant="onDark"
                    haptic="tapLight"
                    onPress={revealAll}
                  />
                )}
              </View>
            </>
          )}
        </View>

        {confetti ? <Confetti onDone={() => setConfetti(false)} /> : null}
      </View>
    </Modal>
  );
}

/**
 * One slot of the pack: the card, its finish, and whether it's new.
 *
 * `front` is the face shown first, and in a sealed pack that is the PRINTED
 * BACK of the card — the flip runs back→face, not face→back.
 */
function Slot({
  pull,
  artUrl,
  width,
  height,
  revealed,
  shimmer,
}: {
  pull: PackResult;
  artUrl: string | null;
  width: number;
  height: number;
  revealed: boolean;
  shimmer: boolean;
}) {
  const card = pull.card;

  return (
    <View style={styles.slot}>
      <View style={{ width, height }}>
        {card ? (
          <FlipCard
            width={width}
            height={height}
            front={<TradingCard card={card} width={width} showBack />}
            back={
              <TradingCard
                card={card}
                artUrl={artUrl}
                variant={effectiveVariant(card, pull.variant)}
                width={width}
              />
            }
            flipped={revealed}
          />
        ) : (
          /* The copy is banked either way — only the card row failed to load.
             Say so plainly rather than showing a blank rectangle. */
          <View style={[styles.mystery, { width, height }]}>
            <AppText variant="caption" color={colors.oliveSoft} align="center">
              Added to your deck
            </AppText>
            <AppText variant="caption" color={colors.oliveSoft} align="center" numberOfLines={2}>
              {pull.cardId}
            </AppText>
          </View>
        )}

        {revealed && pull.isNew ? (
          <View style={styles.ribbon} pointerEvents="none">
            <AppText variant="caption" color={colors.ink} style={styles.ribbonText}>
              NEW
            </AppText>
          </View>
        ) : null}
      </View>

      <AppText
        variant="caption"
        color={revealed ? colors.oliveSoft : 'transparent'}
        align="center"
        numberOfLines={1}
        style={styles.slotLabel}>
        {card ? rarityLabel(card.rarity) : `Slot ${pull.slot}`}
      </AppText>

      {revealed && pull.variant !== 'base' ? (
        <ShimmerLabel label={variantLabel(pull.variant)} animate={shimmer} />
      ) : (
        <View style={styles.labelSpacer} />
      )}
    </View>
  );
}

/**
 * The FOIL / HOLO tag under a card that came out shiny.
 *
 * A slow opacity breath rather than a moving highlight: the card itself
 * already carries the finish, and this only has to say which one it is. Off
 * entirely under reduced motion, where it renders as a plain tag.
 */
function ShimmerLabel({ label, animate }: { label: string; animate: boolean }) {
  const progress = useSharedValue(1);

  useEffect(() => {
    if (!animate) {
      progress.value = 1;
      return;
    }
    progress.value = withRepeat(
      withTiming(0.45, { duration: DURATION.lazy, easing: EASE.standard }),
      -1,
      true,
    );
  }, [animate, progress]);

  const style = useAnimatedStyle(() => ({ opacity: progress.value }));

  return (
    <Animated.View style={[styles.variantTag, style]}>
      <AppText variant="caption" color={colors.ink} style={styles.variantTagText}>
        {label}
      </AppText>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(30,25,12,0.9)',
    alignItems: 'center',
    justifyContent: 'center',
    padding: spacing.md,
  },
  sheet: {
    width: '100%',
    maxWidth: 900,
    gap: spacing.sm,
    alignItems: 'center',
  },
  center: {
    alignItems: 'center',
    gap: spacing.md,
    paddingVertical: spacing.xl,
    paddingHorizontal: spacing.md,
  },
  row: {
    gap: spacing.sm,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.md,
  },
  slot: {
    alignItems: 'center',
    gap: spacing.xs,
  },
  slotLabel: {
    textTransform: 'uppercase',
    letterSpacing: 0.6,
  },
  labelSpacer: {
    height: 20,
  },
  mystery: {
    borderRadius: radii.sm,
    borderWidth: 1,
    borderColor: colors.oliveLine,
    backgroundColor: 'rgba(255,243,230,0.06)',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.xs,
    padding: spacing.sm,
  },
  ribbon: {
    position: 'absolute',
    top: spacing.sm,
    left: -spacing.xs,
    backgroundColor: colors.sun,
    borderRadius: radii.sm,
    paddingHorizontal: spacing.sm,
    paddingVertical: 2,
  },
  ribbonText: {
    letterSpacing: 1,
    fontWeight: '700',
  },
  variantTag: {
    backgroundColor: colors.sunLight,
    borderRadius: radii.pill,
    paddingHorizontal: spacing.sm,
    paddingVertical: 1,
  },
  variantTagText: {
    letterSpacing: 1,
    textTransform: 'uppercase',
  },
  actions: {
    flexDirection: 'row',
    gap: spacing.sm,
    borderRadius: radii.pill,
  },
});
