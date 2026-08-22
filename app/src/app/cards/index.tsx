import Ionicons from '@expo/vector-icons/Ionicons';
import { FlashList } from '@shopify/flash-list';
import { Stack, useFocusEffect, useRouter } from 'expo-router';
import { useCallback, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Platform,
  ScrollView,
  StyleSheet,
  TextInput,
  useWindowDimensions,
  View,
} from 'react-native';

import { PackOpening } from '@/components/cards/PackOpening';
import { TradingCard } from '@/components/cards/TradingCard';
import {
  AnimatedPressable,
  AppText,
  Button,
  Card,
  Chip,
  EmptyState,
  FadeInUp,
  Screen,
  Skeleton,
} from '@/components/ui';
import { colors, radii, spacing } from '@/constants/theme';
import {
  CARD_RARITIES,
  CARD_TYPES,
  CARD_VARIANTS,
  cardTypeLabel,
  effectiveVariant,
  fetchCardArtUrls,
  fetchCards,
  fetchCardSet,
  rarityLabel,
  type CardRarity,
  type CardRecord,
  type CardSet,
  type CardType,
  type CardVariant,
} from '@/lib/cards';
import { useRole } from '@/lib/role';
import { supabase } from '@/lib/supabase';

type LoadState = 'loading' | 'ok' | 'unavailable';

/** Signed-in / signed-out, without pretending "loading" is "signed out". */
function useSignedIn(): 'loading' | 'in' | 'out' {
  const [state, setState] = useState<'loading' | 'in' | 'out'>('loading');
  useFocusEffect(
    useCallback(() => {
      let cancelled = false;
      void supabase.auth.getSession().then(({ data }) => {
        if (!cancelled) setState(data.session?.user?.email ? 'in' : 'out');
      });
      return () => {
        cancelled = true;
      };
    }, []),
  );
  return state;
}

/**
 * The binder: every card in the set, filterable, in whichever finish you feel
 * like looking at today.
 *
 * The whole deck is 61 rows and every card is signed in ONE storage request,
 * so this loads as a single pass rather than a per-card waterfall. The grid is
 * a `FlashList` because a card is an expensive cell — an SVG wash, a burst
 * badge and up to three gradient overlays each — and recycling them matters
 * more here than in any other list in the app.
 */
export default function CardsScreen() {
  const router = useRouter();
  const role = useRole();
  const isAdmin = role?.isAdmin ?? false;
  const signedIn = useSignedIn();
  const { width } = useWindowDimensions();

  const [state, setState] = useState<LoadState>('loading');
  const [cards, setCards] = useState<CardRecord[]>([]);
  const [set, setSet] = useState<CardSet | null>(null);
  const [artUrls, setArtUrls] = useState<Map<string, string>>(new Map());
  const [refreshing, setRefreshing] = useState(false);

  const [search, setSearch] = useState('');
  const [typeFilter, setTypeFilter] = useState<CardType | null>(null);
  const [rarityFilter, setRarityFilter] = useState<CardRarity | null>(null);
  const [variant, setVariant] = useState<CardVariant>('base');
  const [packOpen, setPackOpen] = useState(false);

  const load = useCallback(async () => {
    const [setRow, result] = await Promise.all([fetchCardSet(), fetchCards()]);
    setSet(setRow);
    if (result.status !== 'ok') {
      setCards([]);
      setArtUrls(new Map());
      setState('unavailable');
      return;
    }
    setCards(result.cards);
    setState('ok');
    setArtUrls(await fetchCardArtUrls(result.cards));
  }, []);

  useFocusEffect(
    useCallback(() => {
      let cancelled = false;
      void load().catch(() => {
        if (!cancelled) setState('unavailable');
      });
      return () => {
        cancelled = true;
      };
    }, [load]),
  );

  const onRefresh = useCallback(() => {
    setRefreshing(true);
    void load().finally(() => setRefreshing(false));
  }, [load]);

  // --- layout ---------------------------------------------------------------
  // Three columns is a desktop-browser affordance; a phone in landscape is
  // still a phone and two columns keeps the type readable.
  const columns = Platform.OS === 'web' && width >= 900 ? 3 : 2;
  const listWidth = Math.min(width, 1280) - spacing.md * 2;
  const cellWidth = listWidth / columns;
  const cardWidth = Math.max(96, Math.floor(cellWidth - spacing.sm));

  // --- filtering ------------------------------------------------------------
  const visible = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return cards.filter((card) => {
      if (typeFilter && card.card_type !== typeFilter) return false;
      if (rarityFilter && card.rarity !== rarityFilter) return false;
      if (!needle) return true;
      return [
        card.title,
        card.ability,
        card.flavor,
        card.job_number,
        card.location,
        card.service_type,
        card.role,
        card.id,
      ]
        .filter(Boolean)
        .some((field) => String(field).toLowerCase().includes(needle));
    });
  }, [cards, search, typeFilter, rarityFilter]);

  const filtered = typeFilter !== null || rarityFilter !== null || search.trim().length > 0;

  // --- signed out -----------------------------------------------------------
  if (signedIn !== 'in') {
    return (
      <>
        <Stack.Screen options={{ title: 'Trading Cards' }} />
        <Screen edges={[]}>
          {signedIn === 'loading' ? (
            <Card style={styles.center}>
              <ActivityIndicator color={colors.accentPrimary} />
            </Card>
          ) : (
            <Card style={styles.center}>
              <View style={styles.badge}>
                <Ionicons name="albums" size={26} color={colors.accentPrimary} />
              </View>
              <AppText variant="heading" align="center">
                Sign in to open the binder
              </AppText>
              <AppText variant="body" color={colors.textMuted} align="center">
                DC Solar: The Trading Card Game is the company deck — 61 cards of real jobs, real
                crew and one cow. It is only visible to signed-in crew members.
              </AppText>
            </Card>
          )}
        </Screen>
      </>
    );
  }

  return (
    <>
      <Stack.Screen options={{ title: 'Trading Cards' }} />
      <Screen edges={[]} scroll={false} padded={false}>
        {/* The toolbar deliberately does NOT scroll with the grid: a search
            field inside a list header loses focus every time the list
            re-renders, which is every keystroke. */}
        <View style={styles.toolbar}>
          <View style={styles.setRow}>
            <View style={styles.setTitles}>
              <AppText variant="heading">{set?.name ?? 'DC Solar: The Trading Card Game'}</AppText>
              <AppText variant="caption" color={colors.textMuted}>
                {set?.tagline ?? 'Catch rays. Get paid.'}
                {state === 'ok' ? ` · ${cards.length} cards` : ''}
              </AppText>
            </View>
            <AnimatedPressable
              onPress={() => router.push('/cards/rules')}
              haptic="tapLight"
              hitSlop={8}
              accessibilityRole="button"
              accessibilityLabel="Read the rules"
              style={styles.rulesLink}>
              <Ionicons name="book-outline" size={15} color={colors.accentLink} />
              <AppText variant="caption" color={colors.accentLink}>
                Rules
              </AppText>
            </AnimatedPressable>
          </View>

          <View style={styles.searchWrap}>
            <Ionicons name="search" size={16} color={colors.textMuted} />
            <TextInput
              value={search}
              onChangeText={setSearch}
              placeholder="Search cards, jobs, abilities"
              placeholderTextColor={colors.textMuted}
              autoCorrect={false}
              style={styles.searchInput}
              returnKeyType="search"
            />
            {search.length > 0 ? (
              <AnimatedPressable
                onPress={() => setSearch('')}
                hitSlop={8}
                accessibilityRole="button"
                accessibilityLabel="Clear search">
                <Ionicons name="close-circle" size={16} color={colors.textMuted} />
              </AnimatedPressable>
            ) : null}
          </View>

          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={styles.chipRow}>
            <Chip
              label="All types"
              tone="olive"
              selected={typeFilter === null}
              onPress={() => setTypeFilter(null)}
            />
            {CARD_TYPES.map((type) => (
              <Chip
                key={type}
                label={cardTypeLabel(type)}
                tone="olive"
                selected={typeFilter === type}
                onPress={() => setTypeFilter(typeFilter === type ? null : type)}
              />
            ))}
          </ScrollView>

          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={styles.chipRow}>
            <Chip
              label="All rarities"
              tone="ocean"
              selected={rarityFilter === null}
              onPress={() => setRarityFilter(null)}
            />
            {CARD_RARITIES.map((rarity) => (
              <Chip
                key={rarity}
                label={rarityLabel(rarity)}
                tone="ocean"
                selected={rarityFilter === rarity}
                onPress={() => setRarityFilter(rarityFilter === rarity ? null : rarity)}
              />
            ))}
          </ScrollView>

          <View style={styles.actionRow}>
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
            <View style={styles.variantRow}>
              {state === 'ok' && cards.length > 0 ? (
                <Button
                  label="Open a pack"
                  icon="gift-outline"
                  variant="secondary"
                  size="sm"
                  onPress={() => setPackOpen(true)}
                />
              ) : null}
              {isAdmin ? (
                <Button
                  label="New card"
                  icon="add"
                  variant="primary"
                  size="sm"
                  onPress={() => router.push('/cards/editor')}
                />
              ) : null}
            </View>
          </View>
        </View>

        {state === 'loading' ? (
          <View style={styles.skeletonGrid}>
            {Array.from({ length: columns * 2 }, (_, i) => (
              <Skeleton
                key={i}
                width={cardWidth}
                height={cardWidth * 1.4}
                radius={radii.sm}
                style={styles.skeletonCell}
              />
            ))}
          </View>
        ) : state === 'unavailable' ? (
          <EmptyState
            icon="cloud-offline-outline"
            title="The card set is unavailable"
            body="The deck could not be loaded. Pull down to try again once you are back on a signal."
            action={{ label: 'Try again', onPress: onRefresh }}
          />
        ) : visible.length === 0 ? (
          <EmptyState
            icon="albums-outline"
            title={filtered ? 'No cards match that' : 'The set is empty'}
            body={
              filtered
                ? 'Try a different type, rarity, or search term.'
                : isAdmin
                  ? 'Nothing has been printed yet. Add the first card to start the set.'
                  : 'Nothing has been printed in this set yet.'
            }
            action={
              filtered
                ? {
                    label: 'Clear filters',
                    onPress: () => {
                      setSearch('');
                      setTypeFilter(null);
                      setRarityFilter(null);
                    },
                  }
                : isAdmin
                  ? { label: 'Add a card', onPress: () => router.push('/cards/editor') }
                  : undefined
            }
          />
        ) : (
          <View style={styles.listWrap}>
            <FlashList
            data={visible}
            numColumns={columns}
            keyExtractor={(item) => item.id}
            refreshing={refreshing}
            onRefresh={onRefresh}
            contentContainerStyle={styles.list}
            renderItem={({ item, index }) => (
              <FadeInUp index={index} style={styles.cell}>
                <AnimatedPressable
                  onPress={() => router.push({ pathname: '/cards/[id]', params: { id: item.id } })}
                  haptic="tapLight"
                  scaleTo={0.97}
                  accessibilityRole="button"
                  accessibilityLabel={`${item.title}, ${item.rarity} ${item.card_type} card`}>
                  <TradingCard
                    card={item}
                    artUrl={artUrls.get(item.id) ?? null}
                    variant={effectiveVariant(item, variant)}
                    width={cardWidth}
                  />
                </AnimatedPressable>
              </FadeInUp>
              )}
            />
          </View>
        )}

        {packOpen ? (
          <PackOpening
            cards={cards}
            artUrls={artUrls}
            variant={variant}
            onClose={() => setPackOpen(false)}
          />
        ) : null}
      </Screen>
    </>
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
  toolbar: {
    paddingHorizontal: spacing.md,
    paddingTop: spacing.sm,
    gap: spacing.sm,
  },
  setRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    gap: spacing.sm,
  },
  setTitles: {
    flexShrink: 1,
    gap: 2,
  },
  rulesLink: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
    paddingTop: 2,
  },
  searchWrap: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    backgroundColor: colors.surface,
    borderRadius: radii.pill,
    borderWidth: 1,
    borderColor: colors.border,
    paddingHorizontal: spacing.md,
    paddingVertical: Platform.OS === 'web' ? spacing.sm : spacing.xs + 2,
  },
  searchInput: {
    flex: 1,
    color: colors.textPrimary,
    fontSize: 15,
    paddingVertical: 2,
  },
  chipRow: {
    gap: spacing.xs + 2,
    paddingRight: spacing.md,
  },
  actionRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    flexWrap: 'wrap',
    gap: spacing.sm,
    paddingBottom: spacing.xs,
  },
  variantRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs + 2,
    flexWrap: 'wrap',
  },
  listWrap: {
    flex: 1,
  },
  list: {
    paddingHorizontal: spacing.md,
    paddingBottom: spacing.xxl,
  },
  cell: {
    alignItems: 'center',
    paddingBottom: spacing.sm,
  },
  skeletonGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    paddingHorizontal: spacing.md,
    gap: spacing.sm,
  },
  skeletonCell: {
    marginBottom: spacing.sm,
  },
});
