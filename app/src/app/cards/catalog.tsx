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

import { TradingCard } from '@/components/cards/TradingCard';
import {
  AnimatedPressable,
  AppText,
  Button,
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
  variantLabel,
  type CardRarity,
  type CardRecord,
  type CardSet,
  type CardType,
  type CardVariant,
} from '@/lib/cards';
import { useRoleGate } from '@/lib/role';

type LoadState = 'loading' | 'ok' | 'unavailable';

/**
 * THE CATALOG — every printed card, and ADMINS ONLY.
 *
 * This screen used to be `/cards`, back when the deck was a thing everybody
 * could page through. It isn't any more: a crew member sees only the cards
 * they have actually pulled (`/cards`, "My Deck"), and the complete 61-card
 * binder is an owner/operator view — it is the editing surface, and knowing
 * what is left to pull is most of the fun of pulling it.
 *
 * The gate here is a courtesy, not the boundary. `cards` SELECT is restricted
 * server-side, so a viewer who reaches this route by URL gets an empty read,
 * which `fetchCards` reports as `unavailable` rather than as an empty set —
 * see the note on that function about why zero rows means "denied".
 *
 * The grid is a `FlashList` because a card is an expensive cell — an SVG
 * wash, a burst badge and up to three gradient overlays each — and recycling
 * them matters more here than in any other list in the app.
 */
export default function CardCatalogScreen() {
  const router = useRouter();
  const { phase, role } = useRoleGate();
  const isAdmin = role?.isAdmin ?? false;
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
  const [showArchived, setShowArchived] = useState(false);

  const load = useCallback(async () => {
    const [setRow, result] = await Promise.all([
      fetchCardSet(),
      fetchCards({ includeArchived: showArchived }),
    ]);
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
  }, [showArchived]);

  useFocusEffect(
    useCallback(() => {
      if (phase !== 'ready' || !isAdmin) return;
      let cancelled = false;
      void load().catch(() => {
        if (!cancelled) setState('unavailable');
      });
      return () => {
        cancelled = true;
      };
    }, [load, phase, isAdmin]),
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

  if (phase === 'loading') {
    return (
      <>
        <Stack.Screen options={{ title: 'Card catalog' }} />
        <Screen edges={[]}>
          <View style={styles.center}>
            <ActivityIndicator color={colors.accentPrimary} />
          </View>
        </Screen>
      </>
    );
  }

  if (!isAdmin) {
    return (
      <>
        <Stack.Screen options={{ title: 'Card catalog' }} />
        <Screen edges={[]}>
          <EmptyState
            icon="lock-closed-outline"
            title="Admins only"
            body="The full card catalog belongs to the owner and operators. Your own cards are in My Deck — you get a pack for every ten hours you work."
            action={{ label: 'Go to My Deck', onPress: () => router.replace('/cards') }}
          />
        </Screen>
      </>
    );
  }

  return (
    <>
      <Stack.Screen options={{ title: 'Card catalog' }} />
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
                  label={variantLabel(option)}
                  tone="sun"
                  selected={variant === option}
                  onPress={() => setVariant(option)}
                />
              ))}
              <Chip
                label="Archived"
                tone="danger"
                icon="archive-outline"
                selected={showArchived}
                onPress={() => setShowArchived((value) => !value)}
              />
            </View>
            <Button
              label="New card"
              icon="add"
              variant="primary"
              size="sm"
              onPress={() => router.push('/cards/editor')}
            />
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
            body="The catalog could not be loaded. Try again once you are back on a signal."
            action={{ label: 'Try again', onPress: onRefresh }}
          />
        ) : visible.length === 0 ? (
          <EmptyState
            icon="albums-outline"
            title={filtered ? 'No cards match that' : 'The set is empty'}
            body={
              filtered
                ? 'Try a different type, rarity, or search term.'
                : 'Nothing has been printed yet. Add the first card to start the set.'
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
                : { label: 'Add a card', onPress: () => router.push('/cards/editor') }
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
                    onPress={() =>
                      router.push({ pathname: '/cards/[id]', params: { id: item.id } })
                    }
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
