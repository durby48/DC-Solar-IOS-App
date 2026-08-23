import Ionicons from '@expo/vector-icons/Ionicons';
import { Stack, useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useState } from 'react';
import { ActivityIndicator, StyleSheet, useWindowDimensions, View } from 'react-native';

import { FlipCard } from '@/components/cards/FlipCard';
import { CARD_ASPECT, TradingCard } from '@/components/cards/TradingCard';
import { TiltCard } from '@/components/cards/TiltCard';
import {
  AnimatedPressable,
  AppText,
  Button,
  Card,
  Chip,
  EmptyState,
  ListRow,
  Screen,
  SectionHeader,
} from '@/components/ui';
import { colors, radii, spacing } from '@/constants/theme';
import {
  CARD_VARIANTS,
  cardStats,
  cardTypeLabel,
  effectiveVariant,
  fetchCard,
  fetchCardArtUrls,
  fetchCardEmployeeName,
  fetchOwnedCard,
  ownershipLabel,
  rarityLabel,
  type CardOwnership,
  type CardRecord,
  type CardVariant,
} from '@/lib/cards';
import { useRole } from '@/lib/role';
import { supabase } from '@/lib/supabase';

type LoadState = 'loading' | 'ok' | 'missing';

/**
 * One card, big.
 *
 * The stack is `TiltCard → FlipCard → TradingCard` and the order is not
 * arbitrary: tilt is a property of the physical object, so it wraps
 * everything; the flip swaps which face that object is showing; the renderer
 * draws whichever face it was handed. Inverting any two of those makes the
 * back of the card refuse to tilt, or the tilt reset every time you turn it
 * over.
 *
 * TWO WAYS IN, BECAUSE THE CATALOG IS ADMIN-ONLY. `cards` SELECT is
 * restricted to owner/operator, so `fetchCard` returns null for a crew member
 * on every card — including the one they just pulled. `fetchOwnedCard` is the
 * fallback: `my_cards()` carries the whole card row for every copy a person
 * owns, so their own cards open normally and a card they don't own reads as
 * "not in your deck", which for them is the honest answer.
 *
 * Both reads run for everybody, not just for viewers, because the ownership
 * line ("You own ×3") is shown to admins too — editing the set does not put a
 * card in your binder.
 */
export default function CardDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const role = useRole();
  const isAdmin = role?.isAdmin ?? false;
  const { width } = useWindowDimensions();

  const [state, setState] = useState<LoadState>('loading');
  const [card, setCard] = useState<CardRecord | null>(null);
  const [artUrl, setArtUrl] = useState<string | null>(null);
  const [employeeName, setEmployeeName] = useState<string | null>(null);
  const [variant, setVariant] = useState<CardVariant>('base');
  const [signedIn, setSignedIn] = useState<boolean | null>(null);
  const [ownership, setOwnership] = useState<CardOwnership | null>(null);

  useFocusEffect(
    useCallback(() => {
      let cancelled = false;

      const run = async () => {
        const { data } = await supabase.auth.getSession();
        if (cancelled) return;
        const authed = Boolean(data.session?.user?.email);
        setSignedIn(authed);
        if (!authed || !id) {
          setState(authed ? 'missing' : 'loading');
          return;
        }

        // The catalog read and the personal read, together. Either one alone
        // is wrong for somebody: admins need the ownership line, crew get
        // nothing at all from the catalog.
        const [catalogRow, owned] = await Promise.all([fetchCard(id), fetchOwnedCard(id)]);
        if (cancelled) return;

        setOwnership(owned?.ownership ?? null);
        const row = catalogRow ?? owned?.card ?? null;
        if (!row) {
          setCard(null);
          setState('missing');
          return;
        }
        setCard(row);
        setState('ok');

        // Show it in the best finish this person actually pulled — a foil in
        // your binder should not open as the base printing.
        if (owned) {
          const counts = owned.ownership.countsByVariant;
          if (counts.holo > 0) setVariant('holo');
          else if (counts.foil > 0) setVariant('foil');
        }

        const urls = await fetchCardArtUrls([row]);
        if (!cancelled) setArtUrl(urls.get(row.id) ?? null);

        if (row.employee_id) {
          const name = await fetchCardEmployeeName(row.employee_id);
          if (!cancelled) setEmployeeName(name);
        } else if (!cancelled) {
          setEmployeeName(null);
        }
      };

      void run();
      return () => {
        cancelled = true;
      };
    }, [id]),
  );

  const cardWidth = Math.min(340, width - spacing.lg * 2);
  const cardHeight = cardWidth * CARD_ASPECT;

  if (signedIn === false) {
    return (
      <>
        <Stack.Screen options={{ title: 'Card' }} />
        <Screen edges={[]}>
          <Card style={styles.center}>
            <View style={styles.badge}>
              <Ionicons name="albums" size={26} color={colors.accentPrimary} />
            </View>
            <AppText variant="heading" align="center">
              Sign in to see this card
            </AppText>
            <AppText variant="body" color={colors.textMuted} align="center">
              The company deck is only visible to signed-in crew members.
            </AppText>
          </Card>
        </Screen>
      </>
    );
  }

  if (state === 'loading') {
    return (
      <>
        <Stack.Screen options={{ title: 'Card' }} />
        <Screen edges={[]}>
          <View style={styles.center}>
            <ActivityIndicator color={colors.accentPrimary} />
          </View>
        </Screen>
      </>
    );
  }

  if (state === 'missing' || !card) {
    return (
      <>
        <Stack.Screen options={{ title: 'Card' }} />
        <Screen edges={[]}>
          <EmptyState
            icon="help-circle-outline"
            title={isAdmin ? 'No card with that name' : 'Not in your deck'}
            body={
              isAdmin
                ? `Nothing in the set is called "${id}". It may have been renamed, or the link is old.`
                : `You haven't pulled "${id}" yet — or there is no such card. Open a pack and find out.`
            }
            action={{ label: 'Back to My Deck', onPress: () => router.replace('/cards') }}
          />
        </Screen>
      </>
    );
  }

  const shown = effectiveVariant(card, variant);
  const stats = cardStats(card);

  return (
    <>
      <Stack.Screen options={{ title: card.title }} />
      <Screen edges={[]}>
        <View style={styles.stage}>
          <TiltCard width={cardWidth} height={cardHeight} radius={radii.sm}>
            <FlipCard
              width={cardWidth}
              height={cardHeight}
              front={
                <TradingCard card={card} artUrl={artUrl} variant={shown} width={cardWidth} />
              }
              back={<TradingCard card={card} width={cardWidth} showBack />}
            />
          </TiltCard>
          <AppText variant="caption" color={colors.textMuted} align="center">
            Tap to turn it over
          </AppText>
        </View>

        {card.holo_only ? (
          <Card tone="sunk">
            <AppText variant="caption" color={colors.textSecondary}>
              This one only exists as a holographic full-art. There is no base printing.
            </AppText>
          </Card>
        ) : (
          <View style={styles.variantRow}>
            {CARD_VARIANTS.map((option) => (
              <Chip
                key={option}
                label={option === 'base' ? 'Base' : option === 'foil' ? 'Foil' : 'Holo'}
                tone="sun"
                selected={variant === option}
                onPress={() => setVariant(option)}
              />
            ))}
          </View>
        )}

        <Card tone={ownership && ownership.copies > 0 ? 'sunk' : undefined}>
          <View style={styles.ownRow}>
            <Ionicons
              name={ownership && ownership.copies > 0 ? 'albums' : 'albums-outline'}
              size={18}
              color={ownership && ownership.copies > 0 ? colors.accentPrimary : colors.textMuted}
            />
            <View style={styles.ownText}>
              <AppText variant="bodyStrong">
                {ownership ? (ownershipLabel(ownership) ?? 'Not in your deck yet') : 'Not in your deck yet'}
              </AppText>
              <AppText variant="caption" color={colors.textMuted}>
                {ownership && ownership.copies > 0
                  ? 'Your copies. Duplicates are how you end up with a shiny one.'
                  : 'You earn a pack for every ten hours worked. Seven cards a pack.'}
              </AppText>
            </View>
          </View>
        </Card>

        {card.archived_at ? (
          <Card tone="danger">
            <AppText variant="bodyStrong">Pulled from the set</AppText>
            <AppText variant="caption" color={colors.textSecondary}>
              This card is archived. It still exists, but it is no longer in the binder.
            </AppText>
          </Card>
        ) : null}

        <Card>
          <SectionHeader title="The card" />
          <Detail label="Type" value={cardTypeLabel(card.card_type)} />
          <Detail label="Rarity" value={rarityLabel(card.rarity)} />
          <Detail
            label="Number"
            value={card.card_number != null ? `#${card.card_number}` : '—'}
          />
          <Detail label="Set" value={card.set_code} />
          {card.ability ? <Detail label="Ability" value={card.ability} stacked /> : null}
          {card.flavor ? <Detail label="Flavor" value={`“${card.flavor}”`} stacked /> : null}
        </Card>

        {stats.length > 0 ? (
          <Card>
            <SectionHeader title="Stats" />
            <View style={styles.statRow}>
              {stats.map((stat) => (
                <View key={stat} style={styles.statPill}>
                  <AppText variant="caption" color={colors.oliveDeep}>
                    {stat}
                  </AppText>
                </View>
              ))}
            </View>
          </Card>
        ) : null}

        {card.job_number || card.job_id || employeeName || card.location ? (
          <Card padded={false}>
            <View style={styles.cardHeader}>
              <SectionHeader title="Where it comes from" style={styles.noMargin} />
            </View>
            {card.job_id ? (
              <ListRow
                title={card.job_number ?? 'The job'}
                subtitle={[card.service_type, card.location].filter(Boolean).join(' · ')}
                icon="briefcase-outline"
                onPress={() =>
                  router.push({ pathname: '/job/[id]', params: { id: card.job_id as string } })
                }
              />
            ) : card.job_number ? (
              <ListRow
                title={card.job_number}
                subtitle="This job is not linked to a record any more"
                icon="briefcase-outline"
              />
            ) : null}
            {employeeName ? (
              <ListRow title={employeeName} subtitle="Drawn from a real person" icon="person-outline" />
            ) : null}
            {!card.job_id && !card.job_number && card.location ? (
              <ListRow title={card.location} subtitle={card.service_type ?? undefined} icon="location-outline" />
            ) : null}
          </Card>
        ) : null}

        {isAdmin ? (
          <Card>
            <SectionHeader title="Admin" />
            {card.art_prompt ? (
              <Detail label="Art prompt" value={card.art_prompt} stacked />
            ) : (
              <Detail label="Art prompt" value="None — AI art can't be generated without one." stacked />
            )}
            <Detail label="Slug" value={card.id} />
            <Detail label="Artwork" value={card.art_path ?? 'No artwork yet'} />
            <Detail label="Version" value={String(card.version)} />
            <Button
              label="Edit this card"
              icon="create-outline"
              variant="secondary"
              size="sm"
              style={styles.editButton}
              onPress={() =>
                router.push({ pathname: '/cards/editor', params: { id: card.id } })
              }
            />
          </Card>
        ) : null}

        <AnimatedPressable
          onPress={() => router.push('/cards/rules')}
          haptic="tapLight"
          accessibilityRole="button"
          accessibilityLabel="Read the rules"
          style={styles.rulesLink}>
          <Ionicons name="book-outline" size={16} color={colors.accentLink} />
          <AppText variant="caption" color={colors.accentLink}>
            How the game is played
          </AppText>
        </AnimatedPressable>
      </Screen>
    </>
  );
}

/** Label/value row. `stacked` for prose that would never fit on one line. */
function Detail({
  label,
  value,
  stacked = false,
}: {
  label: string;
  value: string;
  stacked?: boolean;
}) {
  return (
    <View style={stacked ? styles.detailStacked : styles.detailRow}>
      <AppText variant="caption" color={colors.textMuted}>
        {label}
      </AppText>
      <AppText variant={stacked ? 'body' : 'bodyStrong'} style={stacked ? undefined : styles.detailValue}>
        {value}
      </AppText>
    </View>
  );
}

const styles = StyleSheet.create({
  center: {
    alignItems: 'center',
    gap: spacing.sm,
    paddingVertical: spacing.xl,
  },
  badge: {
    width: 56,
    height: 56,
    borderRadius: radii.pill,
    backgroundColor: colors.oliveTint,
    alignItems: 'center',
    justifyContent: 'center',
  },
  stage: {
    alignItems: 'center',
    gap: spacing.sm,
    paddingTop: spacing.sm,
  },
  variantRow: {
    flexDirection: 'row',
    justifyContent: 'center',
    gap: spacing.xs + 2,
  },
  ownRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: spacing.sm,
  },
  ownText: {
    flexShrink: 1,
    gap: 2,
  },
  detailRow: {
    flexDirection: 'row',
    alignItems: 'baseline',
    justifyContent: 'space-between',
    gap: spacing.md,
    paddingVertical: spacing.xs,
  },
  detailStacked: {
    gap: 2,
    paddingVertical: spacing.xs,
  },
  detailValue: {
    flexShrink: 1,
    textAlign: 'right',
  },
  statRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.sm,
  },
  statPill: {
    backgroundColor: colors.oliveSoft,
    borderRadius: radii.sm,
    paddingHorizontal: spacing.sm + 2,
    paddingVertical: spacing.xs + 1,
  },
  cardHeader: {
    paddingHorizontal: spacing.md,
    paddingTop: spacing.md,
  },
  noMargin: {
    marginBottom: 0,
  },
  editButton: {
    marginTop: spacing.sm,
  },
  rulesLink: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.xs + 2,
    paddingVertical: spacing.md,
  },
});
