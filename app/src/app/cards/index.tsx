import Ionicons from '@expo/vector-icons/Ionicons';
import { FlashList } from '@shopify/flash-list';
import { Stack, useFocusEffect, useRouter } from 'expo-router';
import { useCallback, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Platform,
  ScrollView,
  StyleSheet,
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
  StatTile,
} from '@/components/ui';
import { colors, radii, spacing } from '@/constants/theme';
import {
  CARD_RARITIES,
  CARD_TYPES,
  cardTypeLabel,
  copiesLabel,
  effectiveVariant,
  fetchCardArtUrls,
  fetchCardSet,
  fetchMyCards,
  fetchPackStatus,
  groupOwnedCards,
  isRecentlyObtained,
  rarityLabel,
  variantLabel,
  type CardRarity,
  type CardSet,
  type CardType,
  type CardVariant,
  type OwnedGroup,
  type PackStatus,
} from '@/lib/cards';
import { useRoleGate } from '@/lib/role';
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

/** `hours_to_next` and `total_hours` are shown to a tenth. Nothing finer. */
function tenths(hours: number): number {
  return Math.round(hours * 10) / 10;
}

/** The best finish owned, which is the one the grid draws the card in. */
function bestVariant(group: OwnedGroup): CardVariant {
  if (group.countsByVariant.holo > 0) return 'holo';
  if (group.countsByVariant.foil > 0) return 'foil';
  return 'base';
}

/**
 * MY DECK — the cards this person actually owns, and nobody else's.
 *
 * ────────────────────────────────────────────────────────────────────────
 * EVERYONE STARTS AT ZERO
 * ────────────────────────────────────────────────────────────────────────
 * This screen used to be the whole 61-card binder, open to any signed-in
 * crew member. It is now a personal collection: a pack per ten hours worked,
 * backdated across every hour on the books, seven cards a pack, and the only
 * way a card gets here is that somebody pulled it. The full catalog moved to
 * `/cards/catalog` and is admin-only — which is a server rule (`cards` SELECT
 * is restricted), not a hidden button.
 *
 * Admins get a deck too, on exactly the same terms. Being able to edit the
 * set does not put a card in your binder.
 *
 * The grid is grouped by CARD, not by copy: pulling The Mothership three
 * times is one cell with "×3" on it, plus a chip for each finish owned. A
 * list of three identical cards would read as a bug.
 */
export default function MyDeckScreen() {
  const router = useRouter();
  const { role } = useRoleGate();
  const isAdmin = role?.isAdmin ?? false;
  const signedIn = useSignedIn();
  const { width } = useWindowDimensions();

  const [state, setState] = useState<LoadState>('loading');
  const [groups, setGroups] = useState<OwnedGroup[]>([]);
  const [status, setStatus] = useState<PackStatus | null>(null);
  const [set, setSet] = useState<CardSet | null>(null);
  const [artUrls, setArtUrls] = useState<Map<string, string>>(new Map());
  const [refreshing, setRefreshing] = useState(false);

  const [typeFilter, setTypeFilter] = useState<CardType | null>(null);
  const [rarityFilter, setRarityFilter] = useState<CardRarity | null>(null);
  const [newOnly, setNewOnly] = useState(false);
  const [packOpen, setPackOpen] = useState(false);

  const load = useCallback(async () => {
    const [setRow, packStatus, mine] = await Promise.all([
      fetchCardSet(),
      fetchPackStatus(),
      fetchMyCards(),
    ]);
    setSet(setRow);
    setStatus(packStatus.status === 'ok' ? packStatus.value : null);

    if (mine.status !== 'ok') {
      setGroups([]);
      setArtUrls(new Map());
      setState('unavailable');
      return;
    }
    const grouped = groupOwnedCards(mine.cards);
    setGroups(grouped);
    setState('ok');
    // One signing request for the whole deck. A viewer may only sign the art
    // for cards they own, which is exactly what this list is.
    setArtUrls(await fetchCardArtUrls(grouped.map((group) => group.card)));
  }, []);

  useFocusEffect(
    useCallback(() => {
      if (signedIn !== 'in') return;
      let cancelled = false;
      void load().catch(() => {
        if (!cancelled) setState('unavailable');
      });
      return () => {
        cancelled = true;
      };
    }, [load, signedIn]),
  );

  const onRefresh = useCallback(() => {
    setRefreshing(true);
    void load().finally(() => setRefreshing(false));
  }, [load]);

  // --- layout ---------------------------------------------------------------
  const columns = Platform.OS === 'web' && width >= 900 ? 3 : 2;
  const listWidth = Math.min(width, 1280) - spacing.md * 2;
  const cellWidth = listWidth / columns;
  const cardWidth = Math.max(96, Math.floor(cellWidth - spacing.sm));

  // --- filtering ------------------------------------------------------------
  const visible = useMemo(() => {
    const now = Date.now();
    return groups.filter((group) => {
      if (typeFilter && group.card.card_type !== typeFilter) return false;
      if (rarityFilter && group.card.rarity !== rarityFilter) return false;
      if (newOnly && !isRecentlyObtained(group.newest, now)) return false;
      return true;
    });
  }, [groups, typeFilter, rarityFilter, newOnly]);

  const filtered = typeFilter !== null || rarityFilter !== null || newOnly;
  const totalCopies = useMemo(
    () => groups.reduce((sum, group) => sum + group.copies, 0),
    [groups],
  );

  const clearFilters = useCallback(() => {
    setTypeFilter(null);
    setRarityFilter(null);
    setNewOnly(false);
  }, []);

  // --- signed out -----------------------------------------------------------
  if (signedIn !== 'in') {
    return (
      <>
        <Stack.Screen options={{ title: 'My Deck' }} />
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
                Sign in to open your deck
              </AppText>
              <AppText variant="body" color={colors.textMuted} align="center">
                DC Solar: The Trading Card Game is the company deck — real jobs, real crew and one
                cow. You earn a pack for every ten hours you work, and the cards you pull are
                yours.
              </AppText>
            </Card>
          )}
        </Screen>
      </>
    );
  }

  const packsAvailable = status?.packsAvailable ?? 0;
  const hoursToNext = tenths(status?.hoursToNext ?? 0);

  const header = (
    <View style={styles.header}>
      <Card>
        <View style={styles.headerTop}>
          <View style={styles.headerTitles}>
            <AppText variant="heading">My Deck</AppText>
            <AppText variant="caption" color={colors.textMuted}>
              {state === 'ok' && totalCopies > 0
                ? `${totalCopies} card${totalCopies === 1 ? '' : 's'} · ${groups.length} different`
                : (set?.tagline ?? 'Catch rays. Get paid.')}
            </AppText>
          </View>
          <View style={styles.headerLinks}>
            {isAdmin ? (
              <AnimatedPressable
                onPress={() => router.push('/cards/catalog')}
                haptic="tapLight"
                hitSlop={8}
                accessibilityRole="button"
                accessibilityLabel="Open the card catalog"
                style={styles.link}>
                <Ionicons name="albums-outline" size={15} color={colors.accentLink} />
                <AppText variant="caption" color={colors.accentLink}>
                  Catalog
                </AppText>
              </AnimatedPressable>
            ) : null}
            <AnimatedPressable
              onPress={() => router.push('/cards/rules')}
              haptic="tapLight"
              hitSlop={8}
              accessibilityRole="button"
              accessibilityLabel="Read the rules"
              style={styles.link}>
              <Ionicons name="book-outline" size={15} color={colors.accentLink} />
              <AppText variant="caption" color={colors.accentLink}>
                Rules
              </AppText>
            </AnimatedPressable>
          </View>
        </View>

        <View style={styles.tiles}>
          <StatTile
            label={packsAvailable === 1 ? 'Pack available' : 'Packs available'}
            value={packsAvailable}
            tone="olive"
            compact
            style={styles.tile}
          />
          <StatTile
            label="Hours worked"
            value={tenths(status?.totalHours ?? 0)}
            suffix=" h"
            decimals={1}
            tone={1}
            compact
            style={styles.tile}
          />
        </View>

        <AppText variant="caption" color={colors.textMuted} style={styles.rule}>
          {status
            ? `1 pack per 10 hours worked · ${
                packsAvailable > 0
                  ? `${packsAvailable} waiting`
                  : `next pack in ${hoursToNext} h`
              }`
            : 'Pack status is unavailable right now. Pull down to try again.'}
        </AppText>

        <Button
          label="Open a pack"
          icon="gift-outline"
          variant="primary"
          fullWidth
          disabled={packsAvailable < 1}
          onPress={() => setPackOpen(true)}
          style={styles.packButton}
        />
        {packsAvailable < 1 ? (
          <AppText variant="caption" color={colors.textMuted} align="center" style={styles.reason}>
            {status
              ? hoursToNext > 0
                ? `No packs yet — ${hoursToNext} more hour${hoursToNext === 1 ? '' : 's'} on the clock and one is yours.`
                : 'No packs yet — you earn one for every 10 hours worked.'
              : 'Packs can’t be counted right now.'}
          </AppText>
        ) : null}
      </Card>

      {state === 'ok' && groups.length > 0 ? (
        <>
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
            <Chip
              label="New"
              tone="sun"
              icon="sparkles-outline"
              selected={newOnly}
              onPress={() => setNewOnly((value) => !value)}
            />
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
        </>
      ) : null}
    </View>
  );

  const body = () => {
    if (state === 'loading') {
      return (
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
      );
    }
    if (state === 'unavailable') {
      return (
        <EmptyState
          icon="cloud-offline-outline"
          title="Your deck is unavailable"
          body="Your cards could not be loaded. Pull down to try again once you are back on a signal."
          action={{ label: 'Try again', onPress: onRefresh }}
        />
      );
    }
    if (visible.length === 0) {
      return filtered ? (
        <EmptyState
          icon="funnel-outline"
          title="Nothing in your deck matches that"
          body="Try a different type or rarity — or clear the filters to see everything you own."
          action={{ label: 'Clear filters', onPress: clearFilters }}
        />
      ) : (
        <EmptyState
          icon="gift-outline"
          title="Open your first pack"
          body={
            packsAvailable > 0
              ? 'Seven cards a pack — four common, two uncommon and one hit. Nothing in your deck yet.'
              : 'You earn a pack for every ten hours you work, backdated over every hour you have already put in.'
          }
          action={{ label: 'Open a pack', onPress: () => setPackOpen(true) }}
        />
      );
    }
    return null;
  };

  const empty = body();

  return (
    <>
      <Stack.Screen options={{ title: 'My Deck' }} />
      <Screen edges={[]} scroll={false} padded={false}>
        <FlashList
          data={empty ? [] : visible}
          numColumns={columns}
          keyExtractor={(item) => item.card.id}
          refreshing={refreshing}
          onRefresh={onRefresh}
          contentContainerStyle={styles.list}
          ListHeaderComponent={header}
          ListEmptyComponent={empty ?? undefined}
          renderItem={({ item, index }) => (
            <FadeInUp index={index} style={styles.cell}>
              <AnimatedPressable
                onPress={() =>
                  router.push({ pathname: '/cards/[id]', params: { id: item.card.id } })
                }
                haptic="tapLight"
                scaleTo={0.97}
                accessibilityRole="button"
                accessibilityLabel={`${item.card.title}, ${item.card.rarity} ${item.card.card_type} card, ${item.copies} owned`}>
                <View>
                  <TradingCard
                    card={item.card}
                    artUrl={artUrls.get(item.card.id) ?? null}
                    variant={effectiveVariant(item.card, bestVariant(item))}
                    width={cardWidth}
                  />
                  {copiesLabel(item.copies) ? (
                    <View style={styles.copies} pointerEvents="none">
                      <AppText variant="caption" color={colors.textOnDark} style={styles.copiesText}>
                        {copiesLabel(item.copies)}
                      </AppText>
                    </View>
                  ) : null}
                  {isRecentlyObtained(item.newest) ? (
                    <View style={styles.newTag} pointerEvents="none">
                      <AppText variant="caption" color={colors.ink} style={styles.newTagText}>
                        NEW
                      </AppText>
                    </View>
                  ) : null}
                </View>

                <View style={[styles.variantChips, { width: cardWidth }]}>
                  {item.variants
                    .filter((variant) => variant !== 'base')
                    .map((variant) => (
                      <Chip key={variant} label={variantLabel(variant)} tone="sun" />
                    ))}
                </View>
              </AnimatedPressable>
            </FadeInUp>
          )}
        />

        {packOpen ? (
          <PackOpening
            onClose={() => {
              setPackOpen(false);
              // The pack was debited and the copies banked server-side, so the
              // header count and the grid are both stale the moment it closes.
              void load();
            }}
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
  header: {
    gap: spacing.sm,
    paddingTop: spacing.sm,
    paddingBottom: spacing.sm,
  },
  headerTop: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    gap: spacing.sm,
  },
  headerTitles: {
    flexShrink: 1,
    gap: 2,
  },
  headerLinks: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
  },
  link: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
    paddingTop: 2,
  },
  tiles: {
    flexDirection: 'row',
    gap: spacing.sm,
    marginTop: spacing.sm,
  },
  tile: {
    flex: 1,
  },
  rule: {
    marginTop: spacing.sm,
  },
  packButton: {
    marginTop: spacing.sm,
  },
  reason: {
    marginTop: spacing.xs,
  },
  chipRow: {
    gap: spacing.xs + 2,
    paddingRight: spacing.md,
  },
  list: {
    paddingHorizontal: spacing.md,
    paddingBottom: spacing.xxl,
  },
  cell: {
    alignItems: 'center',
    paddingBottom: spacing.sm,
  },
  copies: {
    position: 'absolute',
    top: spacing.xs,
    right: spacing.xs,
    minWidth: 30,
    alignItems: 'center',
    backgroundColor: colors.oliveDeep,
    borderRadius: radii.pill,
    paddingHorizontal: spacing.sm,
    paddingVertical: 1,
  },
  copiesText: {
    fontWeight: '700',
  },
  newTag: {
    position: 'absolute',
    top: spacing.xs,
    left: spacing.xs,
    backgroundColor: colors.sun,
    borderRadius: radii.sm,
    paddingHorizontal: spacing.xs + 2,
    paddingVertical: 1,
  },
  newTagText: {
    fontWeight: '700',
    letterSpacing: 0.8,
    fontSize: 10,
  },
  variantChips: {
    flexDirection: 'row',
    justifyContent: 'center',
    flexWrap: 'wrap',
    gap: spacing.xs,
    paddingTop: spacing.xs,
    minHeight: 4,
  },
  skeletonGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.sm,
  },
  skeletonCell: {
    marginBottom: spacing.sm,
  },
});
