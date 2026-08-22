import { Image } from 'expo-image';
import { useCallback, useEffect, useState } from 'react';
import { FlatList, StyleSheet, View } from 'react-native';

import { AppText, Card, SectionHeader, Skeleton } from '@/components/ui';
import { colors, radii, spacing } from '@/constants/theme';
import { fetchMarketingPhotos, type MarketingPhoto } from '@/lib/marketingPhotos';

/**
 * The installation-photo strip at the top of the Marketing panel.
 *
 * It sits ABOVE the platform cards in every state, and that placement is the
 * point. With no platform connected the rest of the panel is four cards that
 * say "Not connected"; this strip is the one thing on the screen that is real
 * work, actually done, actually photographed. Marketing should open with the
 * roofs, not with an apology.
 *
 * RENDERS NOTHING when the library isn't configured — no header, no empty
 * card, no mention of Dropbox. See `lib/marketingPhotos.ts` for why: a crew
 * member who has never heard of the sync should not be told its folder is
 * empty. `unavailable` gets one quiet line, because that one is a fault.
 *
 * "See all" is a PLACEHOLDER. The full gallery (lightbox, captions, tags)
 * ships with the Dropbox workstream; until then the action says so inline
 * rather than pushing a route that doesn't exist yet. Replace this handler —
 * not the strip — when the gallery lands.
 */

const THUMB = 104;

export function MarketingPhotos({ refreshKey = 0 }: { refreshKey?: number }) {
  const [state, setState] = useState<'loading' | 'ok' | 'not-configured' | 'unavailable'>(
    'loading',
  );
  const [photos, setPhotos] = useState<MarketingPhoto[]>([]);
  const [note, setNote] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setState('loading');
    fetchMarketingPhotos().then((result) => {
      if (cancelled) return;
      if (result.status === 'ok') {
        setPhotos(result.photos);
        setState('ok');
      } else {
        setPhotos([]);
        setState(result.status);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [refreshKey]);

  const showNote = useCallback(() => setNote(true), []);

  if (state === 'not-configured') return null;

  if (state === 'loading') {
    return (
      <View style={styles.wrap}>
        <SectionHeader title="Installation photos" />
        <View style={styles.row}>
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} width={THUMB} height={THUMB} radius={radii.md} />
          ))}
        </View>
      </View>
    );
  }

  if (state === 'unavailable') {
    return (
      <View style={styles.wrap}>
        <SectionHeader title="Installation photos" />
        <Card tone="sunk">
          <AppText variant="body" color={colors.textMuted}>
            Photos couldn&apos;t load right now. Pull down to retry.
          </AppText>
        </Card>
      </View>
    );
  }

  return (
    <View style={styles.wrap}>
      <SectionHeader
        title="Installation photos"
        action={{ label: 'See all', onPress: showNote }}
      />
      {note ? (
        <Card tone="sunk" style={styles.note}>
          <AppText variant="body" color={colors.textMuted}>
            Gallery coming with the Dropbox sync.
          </AppText>
        </Card>
      ) : null}
      <FlatList
        data={photos}
        keyExtractor={(item) => item.id}
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.list}
        renderItem={({ item }) => (
          <Image
            source={{ uri: item.url }}
            style={styles.thumb}
            contentFit="cover"
            transition={150}
            cachePolicy="memory-disk"
            accessibilityLabel={item.caption ?? 'Installation photo'}
          />
        )}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    marginTop: spacing.md,
    gap: spacing.xs,
  },
  row: {
    flexDirection: 'row',
    gap: spacing.sm,
  },
  list: {
    gap: spacing.sm,
    paddingRight: spacing.sm,
  },
  note: {
    marginBottom: spacing.xs,
  },
  thumb: {
    width: THUMB,
    height: THUMB,
    borderRadius: radii.md,
    backgroundColor: colors.surfaceSunk,
  },
});
