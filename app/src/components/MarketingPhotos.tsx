import { Image } from 'expo-image';
import { router } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { FlatList, StyleSheet, View } from 'react-native';

import { MediaLightbox, type LightboxItem } from '@/components/MediaLightbox';
import { AnimatedPressable, AppText, Card, SectionHeader, Skeleton } from '@/components/ui';
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
 * "See all" now goes to `/marketing-photos` — the full gallery, with the tag
 * filter, the Dropbox status header and the admin "Sync now". Tapping a
 * thumbnail here opens the same `MediaLightbox` in place, so the strip is a
 * usable viewer on its own and the route is for browsing everything.
 *
 * These items carry no `assetId`: the strip's own query
 * (`lib/marketingPhotos.ts`) does not select the columns the edit sheet
 * writes, so captions and tags are edited in the gallery rather than half-
 * edited from here.
 */

const THUMB = 104;

export function MarketingPhotos({ refreshKey = 0 }: { refreshKey?: number }) {
  const [state, setState] = useState<'loading' | 'ok' | 'not-configured' | 'unavailable'>(
    'loading',
  );
  const [photos, setPhotos] = useState<MarketingPhoto[]>([]);
  const [viewerIndex, setViewerIndex] = useState<number | null>(null);

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

  const seeAll = useCallback(() => router.push('/marketing-photos'), []);

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
        action={{ label: 'See all', onPress: seeAll, icon: 'chevron-forward' }}
      />
      <FlatList
        data={photos}
        keyExtractor={(item) => item.id}
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.list}
        renderItem={({ item, index }) => (
          <AnimatedPressable
            onPress={() => setViewerIndex(index)}
            haptic="tapLight"
            scaleTo={0.96}
            accessibilityRole="imagebutton"
            accessibilityLabel={item.caption ?? 'Installation photo'}>
            <Image
              source={{ uri: item.url }}
              style={styles.thumb}
              contentFit="cover"
              transition={150}
              cachePolicy="memory-disk"
            />
          </AnimatedPressable>
        )}
      />

      {viewerIndex !== null ? (
        <MediaLightbox
          items={photos.map(toLightboxItem)}
          index={viewerIndex}
          visible
          onClose={() => setViewerIndex(null)}
        />
      ) : null}
    </View>
  );
}

/** A strip photo as a viewer item. The job number becomes the caption when
 *  there isn't one, because "DC-26012" tells a crew member more than nothing. */
function toLightboxItem(photo: MarketingPhoto): LightboxItem {
  return {
    id: photo.id,
    url: photo.url,
    caption: photo.caption ?? photo.jobNumber,
    takenAt: photo.takenAt,
  };
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
  thumb: {
    width: THUMB,
    height: THUMB,
    borderRadius: radii.md,
    backgroundColor: colors.surfaceSunk,
  },
});
