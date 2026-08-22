import { useEffect, useMemo, useState } from 'react';
import { Modal, ScrollView, StyleSheet, useWindowDimensions, View } from 'react-native';

import { AppText, Button, Confetti } from '@/components/ui';
import { colors, radii, spacing } from '@/constants/theme';
import { haptics } from '@/lib/haptics';
import {
  effectiveVariant,
  rarityLabel,
  type CardRarity,
  type CardRecord,
  type CardVariant,
} from '@/lib/cards';
import { DURATION, useMotion } from '@/lib/motion';
import { FlipCard } from './FlipCard';
import { TradingCard } from './TradingCard';

/**
 * "Open a pack" — five cards off the top of the deck, revealed one at a time.
 *
 * PURELY CLIENT-SIDE, AND DELIBERATELY SO. Nothing here writes to the
 * database: there is no collection to own, no pull history, no economy. It is
 * a five-second bit of theatre over the set the crew can already see in full,
 * which is why the odds below are invented rather than negotiated — the deck
 * has no printed pull rates because it was never sold in packs.
 *
 * The weights are the ones a 1990s booster taught everyone to expect. They are
 * per-slot, so a five-card pack carries roughly a one-in-six chance of a
 * legendary and about one in forty of a secret.
 */
const RARITY_WEIGHTS: Record<CardRarity, number> = {
  common: 60,
  uncommon: 25,
  rare: 11,
  legendary: 3.5,
  secret: 0.5,
};

const PACK_SIZE = 5;
/** Gap between one card turning over and the next. */
const REVEAL_STAGGER = 420;

function rollRarity(): CardRarity {
  const total = Object.values(RARITY_WEIGHTS).reduce((sum, weight) => sum + weight, 0);
  let roll = Math.random() * total;
  for (const [rarity, weight] of Object.entries(RARITY_WEIGHTS) as [CardRarity, number][]) {
    roll -= weight;
    if (roll <= 0) return rarity;
  }
  return 'common';
}

/**
 * Five distinct cards, each drawn at its rarity's odds.
 *
 * When the rolled rarity has nothing left un-drawn (the set has exactly two
 * secrets), the slot falls back to any remaining card rather than repeating
 * one — a pack with the same card twice reads as a bug, not as luck.
 */
function pullPack(cards: CardRecord[]): CardRecord[] {
  const pool = cards.filter((card) => !card.archived_at);
  if (pool.length === 0) return [];

  const taken = new Set<string>();
  const pack: CardRecord[] = [];

  for (let slot = 0; slot < Math.min(PACK_SIZE, pool.length); slot++) {
    const rarity = rollRarity();
    const matching = pool.filter((card) => card.rarity === rarity && !taken.has(card.id));
    const candidates = matching.length > 0 ? matching : pool.filter((card) => !taken.has(card.id));
    const pick = candidates[Math.floor(Math.random() * candidates.length)];
    if (!pick) break;
    taken.add(pick.id);
    pack.push(pick);
  }
  return pack;
}

export function PackOpening({
  cards,
  artUrls,
  variant,
  onClose,
}: {
  cards: CardRecord[];
  artUrls: Map<string, string>;
  /** The finish the collection is currently showing. */
  variant: CardVariant;
  onClose: () => void;
}) {
  const motion = useMotion();
  const { width } = useWindowDimensions();

  const [pack, setPack] = useState<CardRecord[]>(() => pullPack(cards));
  const [revealed, setRevealed] = useState(0);
  const [confetti, setConfetti] = useState(false);
  /** Bumped on "Open another" so the reveal timers restart from scratch. */
  const [round, setRound] = useState(0);

  const hit = useMemo(
    () => pack.some((card) => card.rarity === 'legendary' || card.rarity === 'secret'),
    [pack],
  );

  useEffect(() => {
    setRevealed(0);
    if (!motion.enabled) {
      // No stagger with reduced motion: the cards are simply face-up.
      setRevealed(pack.length);
      return;
    }
    const timers = pack.map((_, index) =>
      setTimeout(
        () => {
          setRevealed(index + 1);
          haptics.tapLight();
        },
        DURATION.base + index * REVEAL_STAGGER,
      ),
    );
    return () => {
      timers.forEach(clearTimeout);
    };
  }, [pack, motion.enabled, round]);

  useEffect(() => {
    if (revealed < pack.length || pack.length === 0) return;
    if (!hit) return;
    haptics.success();
    if (motion.enabled) setConfetti(true);
  }, [revealed, pack.length, hit, motion.enabled]);

  const cardWidth = Math.min(180, Math.max(120, (width - spacing.lg * 2) * 0.46));
  const cardHeight = cardWidth * 1.4;

  const openAnother = () => {
    setConfetti(false);
    setPack(pullPack(cards));
    setRound((value) => value + 1);
  };

  return (
    <Modal visible transparent animationType="fade" onRequestClose={onClose}>
      <View style={styles.backdrop}>
        <View style={styles.sheet}>
          <AppText variant="title" color={colors.textOnDark} align="center">
            {revealed < pack.length ? 'Opening…' : hit ? 'Well look at that.' : 'Your pack'}
          </AppText>
          <AppText variant="caption" color={colors.oliveSoft} align="center">
            Five cards, dealt at booster odds. Nothing is saved — it is a bit of theatre.
          </AppText>

          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={styles.row}>
            {pack.map((card, index) => (
              <View key={`${round}-${card.id}`} style={styles.slot}>
                <FlipCard
                  width={cardWidth}
                  height={cardHeight}
                  // `front` is the face shown first, and in a sealed pack that
                  // is the printed back of the card.
                  front={<TradingCard card={card} width={cardWidth} showBack />}
                  back={
                    <TradingCard
                      card={card}
                      artUrl={artUrls.get(card.id) ?? null}
                      variant={effectiveVariant(card, variant)}
                      width={cardWidth}
                    />
                  }
                  flipped={index < revealed}
                />
                <AppText
                  variant="caption"
                  color={index < revealed ? colors.oliveSoft : 'transparent'}
                  align="center"
                  numberOfLines={1}
                  style={styles.slotLabel}>
                  {rarityLabel(card.rarity)}
                </AppText>
              </View>
            ))}
          </ScrollView>

          <View style={styles.actions}>
            <Button label="Open another" icon="gift-outline" variant="onDark" onPress={openAnother} />
            <Button label="Done" variant="primary" onPress={onClose} />
          </View>
        </View>

        {confetti ? <Confetti onDone={() => setConfetti(false)} /> : null}
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(30,25,12,0.86)',
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
  actions: {
    flexDirection: 'row',
    gap: spacing.sm,
    borderRadius: radii.pill,
  },
});
