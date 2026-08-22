import Ionicons from '@expo/vector-icons/Ionicons';
import { FlashList } from '@shopify/flash-list';
import { Image } from 'expo-image';
import type { ReactNode } from 'react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Platform, StyleSheet, View } from 'react-native';

import { MediaLightbox, assetToLightboxItem, type LightboxItem } from '@/components/MediaLightbox';
import {
  AnimatedPressable,
  AppText,
  Button,
  Card,
  Chip,
  EmptyState,
  FadeInUp,
  Skeleton,
} from '@/components/ui';
import { colors, radii, spacing } from '@/constants/theme';
import * as haptics from '@/lib/haptics';
import {
  DROPBOX_NOT_CONFIGURED,
  collectTags,
  fetchDropboxStatus,
  fetchMediaAssets,
  fetchMediaUrls,
  firstSyncError,
  formatTimestamp,
  summarizeSync,
  syncDropbox,
  type DropboxFolderStatus,
  type MediaAsset,
  type MediaUsage,
} from '@/lib/media';
import { useRole } from '@/lib/role';

/**
 * The photo grid, and the gallery built on top of it.
 *
 * Two exports, deliberately in one file because they are one idea at two
 * levels:
 *
 *   `MediaGrid`    — presentation only. Assets in, signed URLs in, taps out.
 *                    It owns the tag filter chips (and therefore knows which
 *                    photos are actually visible), so `onPress` hands the
 *                    caller BOTH the index and the filtered list — otherwise
 *                    filtering by "roof" and tapping the third tile would open
 *                    the third UNFILTERED photo, which is the bug this API
 *                    shape exists to make impossible.
 *   `MediaGallery` — the whole feature: fetch, sign, Dropbox status header,
 *                    admin "Sync now", grid, lightbox. Mounted by the
 *                    `/marketing-photos` route and by the Sales → Photos
 *                    segment, which differ only in `compact` and who scrolls.
 *
 * THREE COLUMNS, SQUARE. A marketing photo library is browsed by "which one
 * is that", not by reading captions, so the tile is the picture and nothing
 * else. `expo-image` with `cachePolicy="memory-disk"` means scrolling back up
 * costs nothing, and `transition={150}` stops a signed URL popping in.
 *
 * NOT-CONFIGURED IS NOT AN ERROR. Until Devon finishes the Dropbox setup the
 * sync answers 503; the header says so with the docs pointer and the grid
 * shows an ordinary empty state. Nobody is told something failed.
 */

const GAP = spacing.xs / 2;
const DEFAULT_COLUMNS = 3;

// ---------------------------------------------------------------------------
// The grid
// ---------------------------------------------------------------------------

export function MediaGrid({
  assets,
  urls,
  loading = false,
  columns = DEFAULT_COLUMNS,
  scrollable = true,
  showTagFilter = true,
  selectedIds,
  header,
  refreshing = false,
  onRefresh,
  emptyTitle = 'No photos yet',
  emptyBody,
  emptyIcon = 'images-outline',
  onPress,
}: {
  assets: MediaAsset[];
  /** Asset id → signed URL. Missing ids draw a placeholder tile. */
  urls: Map<string, string>;
  loading?: boolean;
  columns?: number;
  /**
   * `true` (the default) renders a `FlashList` that owns its scrolling — use
   * it when the grid fills the screen. `false` renders a plain wrapping grid
   * for embedding inside somebody else's `ScrollView`, which is what the
   * Sales segment and the Employee-of-the-Month picker need.
   */
  scrollable?: boolean;
  showTagFilter?: boolean;
  /** Draws a check badge on these tiles (the EOM picker's selection). */
  selectedIds?: readonly string[];
  /** Rendered above the chips — the Dropbox status card, usually. */
  header?: ReactNode;
  refreshing?: boolean;
  onRefresh?: () => void;
  emptyTitle?: string;
  emptyBody?: string;
  emptyIcon?: keyof typeof Ionicons.glyphMap;
  /** `visible` is the filtered list the index points into. */
  onPress: (index: number, visible: MediaAsset[]) => void;
}) {
  const [activeTag, setActiveTag] = useState<string | null>(null);

  const tags = useMemo(() => collectTags(assets), [assets]);
  const visible = useMemo(
    () => (activeTag ? assets.filter((a) => a.tags.includes(activeTag)) : assets),
    [assets, activeTag],
  );

  // A filter that no longer matches anything (after a sync, or an archive)
  // would leave the grid permanently empty with no obvious way out.
  useEffect(() => {
    if (activeTag && !tags.includes(activeTag)) setActiveTag(null);
  }, [activeTag, tags]);

  const selected = useMemo(
    () => new Set(selectedIds ?? []),
    [selectedIds],
  );

  const chipRow =
    showTagFilter && tags.length > 0 ? (
      <View style={styles.chipRow}>
        <Chip
          label="All"
          tone="olive"
          selected={activeTag === null}
          onPress={() => setActiveTag(null)}
        />
        {tags.map((tag) => (
          <Chip
            key={tag}
            label={tag}
            tone="olive"
            selected={activeTag === tag}
            onPress={() => setActiveTag(activeTag === tag ? null : tag)}
          />
        ))}
      </View>
    ) : null;

  const topMatter =
    header || chipRow ? (
      <View style={styles.top}>
        {header}
        {chipRow}
      </View>
    ) : null;

  if (loading) {
    return (
      <View>
        {topMatter}
        <View style={styles.wrapGrid}>
          {Array.from({ length: columns * 3 }, (_, i) => (
            <View key={i} style={[styles.cell, { width: `${100 / columns}%` }]}>
              {/* The square comes from the wrapper's aspectRatio; `Skeleton`
                  takes a numeric height, so the style override is what makes
                  it fill a cell whose pixel size we don't know. */}
              <View style={styles.tile}>
                <Skeleton width="100%" radius={radii.sm} style={styles.fillHeight} />
              </View>
            </View>
          ))}
        </View>
      </View>
    );
  }

  if (visible.length === 0) {
    return (
      <View>
        {topMatter}
        <EmptyState icon={emptyIcon} title={emptyTitle} body={emptyBody} />
      </View>
    );
  }

  const renderTile = (asset: MediaAsset, index: number) => {
    const url = urls.get(asset.id);
    const isSelected = selected.has(asset.id);
    return (
      <FadeInUp index={index}>
        <AnimatedPressable
          onPress={() => onPress(index, visible)}
          haptic="tapLight"
          scaleTo={0.96}
          accessibilityRole="imagebutton"
          accessibilityLabel={asset.caption ?? asset.fileName ?? 'Photo'}
          style={[styles.tile, isSelected && styles.tileSelected]}>
          {url ? (
            <Image
              source={{ uri: url }}
              style={styles.image}
              contentFit="cover"
              transition={150}
              cachePolicy="memory-disk"
            />
          ) : (
            <View style={[styles.image, styles.imageMissing]}>
              <Ionicons name="image-outline" size={18} color={colors.textMuted} />
            </View>
          )}
          {asset.featured ? (
            <View style={styles.featuredBadge}>
              <Ionicons name="star" size={11} color={colors.ink} />
            </View>
          ) : null}
          {isSelected ? (
            <View style={styles.selectedBadge}>
              <Ionicons name="checkmark" size={13} color={colors.white} />
            </View>
          ) : null}
        </AnimatedPressable>
      </FadeInUp>
    );
  };

  if (!scrollable) {
    return (
      <View>
        {topMatter}
        <View style={styles.wrapGrid}>
          {visible.map((asset, index) => (
            <View key={asset.id} style={[styles.cell, { width: `${100 / columns}%` }]}>
              {renderTile(asset, index)}
            </View>
          ))}
        </View>
      </View>
    );
  }

  return (
    <FlashList
      data={visible}
      numColumns={columns}
      keyExtractor={(asset) => asset.id}
      refreshing={refreshing}
      onRefresh={onRefresh}
      ListHeaderComponent={topMatter}
      contentContainerStyle={styles.listContent}
      renderItem={({ item, index }) => (
        <View style={styles.cellFlex}>{renderTile(item, index)}</View>
      )}
    />
  );
}

// ---------------------------------------------------------------------------
// The Dropbox status header
// ---------------------------------------------------------------------------

function statusLine(folder: DropboxFolderStatus): string {
  const count = `${folder.fileCount} ${folder.fileCount === 1 ? 'photo' : 'photos'}`;
  const synced = formatTimestamp(folder.lastSyncedAt, { withTime: true });
  if (!synced) return `${count} · never synced`;
  return `${count} · synced ${synced}`;
}

/**
 * "12 photos · synced Aug 22, 2026, 3:04 PM" and, for an admin, Sync now.
 *
 * Exported because the Employee-of-the-Month picker needs exactly this header
 * over a grid whose taps SELECT rather than open — so it composes
 * `DropboxStatusCard` + `MediaGrid` itself instead of using `MediaGallery`.
 */
export function DropboxStatusCard({
  usage,
  compact = false,
  onSynced,
}: {
  usage: MediaUsage;
  compact?: boolean;
  onSynced: () => void;
}) {
  const role = useRole();
  const isAdmin = role?.isAdmin ?? false;
  const [folders, setFolders] = useState<DropboxFolderStatus[] | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [noteTone, setNoteTone] = useState<'ok' | 'warn' | 'error'>('ok');

  const load = useCallback(async () => {
    const result = await fetchDropboxStatus();
    setFolders(result.status === 'ok' ? result.folders : []);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const runSync = useCallback(async () => {
    setSyncing(true);
    setNote(null);
    const result = await syncDropbox(usage);
    setSyncing(false);
    if (result.ok) {
      const failure = firstSyncError(result.results);
      if (failure) {
        setNoteTone('warn');
        setNote(failure);
        haptics.warn();
      } else {
        setNoteTone('ok');
        setNote(summarizeSync(result.results));
        haptics.success();
      }
      await load();
      onSynced();
      return;
    }
    // 503 is the DESIGNED state until the one-time setup is done — it gets the
    // documentation pointer, not an error tone.
    setNoteTone(result.code === 'not_configured' ? 'warn' : 'error');
    setNote(result.message);
    if (result.code === 'not_configured') haptics.warn();
    else haptics.error();
  }, [usage, load, onSynced]);

  // Still asking. Drawing "not connected" for a beat and then replacing it
  // with a sync time is worse than drawing nothing.
  if (folders === null) return null;

  const folder = folders.find((f) => f.usage === usage) ?? null;

  // Nothing to say and nothing to offer: don't draw a card about it.
  if (!folder && !isAdmin) return null;

  return (
    <Card tone="sunk" style={styles.statusCard}>
      <View style={styles.statusRow}>
        <View style={styles.statusText}>
          <AppText variant={compact ? 'caption' : 'bodyStrong'}>
            {folder ? 'From Dropbox' : 'Dropbox photo library'}
          </AppText>
          <AppText variant="caption" color={colors.textMuted}>
            {folder ? statusLine(folder) : DROPBOX_NOT_CONFIGURED}
          </AppText>
          {folder?.lastError ? (
            <AppText variant="caption" color={colors.danger}>
              {folder.lastError}
            </AppText>
          ) : null}
        </View>
        {isAdmin ? (
          <Button
            label={syncing ? 'Syncing…' : 'Sync now'}
            onPress={runSync}
            variant="secondary"
            size="sm"
            loading={syncing}
          />
        ) : null}
      </View>
      {note ? (
        <AppText
          variant="caption"
          color={
            noteTone === 'error'
              ? colors.danger
              : noteTone === 'warn'
                ? colors.amberDeep
                : colors.textSecondary
          }>
          {note}
        </AppText>
      ) : null}
    </Card>
  );
}

// ---------------------------------------------------------------------------
// The gallery
// ---------------------------------------------------------------------------

export function MediaGallery({
  usage,
  compact = false,
  scrollable = true,
  showStatus = true,
  limit,
  refreshKey = 0,
  emptyTitle,
  emptyBody,
}: {
  usage: MediaUsage;
  /** Sales' embedded segment: a tighter status card. */
  compact?: boolean;
  /** `false` when a parent `ScrollView` owns the scrolling. */
  scrollable?: boolean;
  showStatus?: boolean;
  limit?: number;
  /** Bump to refetch — pull-to-refresh on the host screen. */
  refreshKey?: number;
  emptyTitle?: string;
  emptyBody?: string;
}) {
  const [assets, setAssets] = useState<MediaAsset[]>([]);
  const [urls, setUrls] = useState<Map<string, string>>(new Map());
  const [state, setState] = useState<'loading' | 'ok' | 'unavailable'>('loading');
  const [refreshing, setRefreshing] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const [viewer, setViewer] = useState<{ items: LightboxItem[]; index: number } | null>(null);

  const role = useRole();

  const load = useCallback(async () => {
    const result = await fetchMediaAssets(usage, { limit });
    if (result.status !== 'ok') {
      setAssets([]);
      setUrls(new Map());
      setState('unavailable');
      return;
    }
    setAssets(result.assets);
    setUrls(await fetchMediaUrls(result.assets));
    setState('ok');
  }, [usage, limit]);

  useEffect(() => {
    // A refetch after a sync keeps the photos on screen rather than flashing
    // back to skeletons; only the first load shows them.
    setState((prev) => (prev === 'ok' ? prev : 'loading'));
    void load();
  }, [load, refreshKey, reloadKey]);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  }, [load]);

  const openViewer = useCallback(
    (index: number, visibleAssets: MediaAsset[]) => {
      const items = visibleAssets
        .map((asset) => {
          const url = urls.get(asset.id);
          return url ? assetToLightboxItem(asset, url) : null;
        })
        .filter((entry): entry is LightboxItem => entry !== null);
      if (items.length === 0) return;
      // The URL-less assets are dropped, so the tapped index has to be
      // recomputed against the list the viewer is actually getting.
      const targetId = visibleAssets[index]?.id;
      const resolved = Math.max(0, items.findIndex((entry) => entry.id === targetId));
      setViewer({ items, index: resolved });
    },
    [urls],
  );

  const header = showStatus ? (
    <DropboxStatusCard
      usage={usage}
      compact={compact}
      onSynced={() => setReloadKey((n) => n + 1)}
    />
  ) : null;

  return (
    <View style={scrollable ? styles.fill : undefined}>
      <MediaGrid
        assets={assets}
        urls={urls}
        loading={state === 'loading'}
        scrollable={scrollable}
        header={header}
        refreshing={refreshing}
        onRefresh={scrollable ? onRefresh : undefined}
        emptyTitle={emptyTitle ?? (state === 'unavailable' ? 'Photos unavailable' : 'No photos yet')}
        emptyBody={
          emptyBody ??
          (state === 'unavailable'
            ? 'Sign in with a DC Solar account to see the photo library.'
            : 'Photos dropped into the Dropbox folder appear here after the next sync.')
        }
        onPress={openViewer}
      />

      {viewer ? (
        <MediaLightbox
          items={viewer.items}
          index={viewer.index}
          visible
          canEdit={role?.isAdmin ?? false}
          onClose={() => setViewer(null)}
          onChanged={() => setReloadKey((n) => n + 1)}
        />
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  fill: {
    flex: 1,
  },
  top: {
    gap: spacing.sm,
    marginBottom: spacing.sm,
  },
  chipRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.xs,
  },
  statusCard: {
    gap: spacing.xs,
  },
  statusRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.sm,
  },
  statusText: {
    flexShrink: 1,
    gap: 2,
  },
  listContent: {
    paddingBottom: spacing.xl,
  },
  wrapGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
  },
  cell: {
    padding: GAP,
  },
  cellFlex: {
    flex: 1,
    padding: GAP,
  },
  fillHeight: {
    height: '100%',
  },
  tile: {
    width: '100%',
    aspectRatio: 1,
    borderRadius: radii.sm,
    overflow: 'hidden',
    backgroundColor: colors.surfaceSunk,
    // A hairline keeps a white-heavy photo from bleeding into the cream page.
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    ...(Platform.OS === 'web' ? { cursor: 'pointer' as const } : null),
  },
  tileSelected: {
    borderWidth: 3,
    borderColor: colors.accentPrimary,
  },
  image: {
    width: '100%',
    height: '100%',
  },
  imageMissing: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  featuredBadge: {
    position: 'absolute',
    top: 4,
    left: 4,
    width: 20,
    height: 20,
    borderRadius: radii.pill,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.accentAction,
  },
  selectedBadge: {
    position: 'absolute',
    top: 4,
    right: 4,
    width: 22,
    height: 22,
    borderRadius: radii.pill,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.accentPrimary,
  },
});
