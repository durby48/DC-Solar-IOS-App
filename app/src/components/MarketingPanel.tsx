import Ionicons from '@expo/vector-icons/Ionicons';
import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Alert, Platform, Pressable, StyleSheet, Text, View } from 'react-native';

import { MarketingPhotos } from '@/components/MarketingPhotos';
import { Card, EmptyState } from '@/components/ui';
import { colors, radii, shadows, spacing } from '@/constants/theme';
import { formatShortDate } from '@/lib/dates';
import {
  MARKETING_PERIODS,
  MARKETING_PLATFORMS,
  PLATFORM_LABELS,
  PLATFORM_METRICS,
  PLATFORM_SHORT,
  fetchMarketingOverview,
  firstName,
  formatMetric,
  type MarketingConnection,
  type MarketingOverview,
  type MarketingPeriod,
  type MarketingPlatform,
  type MarketingReview,
} from '@/lib/marketing';
import { useRole } from '@/lib/role';

/**
 * Marketing panel — the second segment of the Sales tab.
 *
 * Reputation and reach for the four places a Kansas City homeowner actually
 * looks us up. It sits next to the sales funnel on purpose: "where did this
 * month's leads come from" is a marketing question with a sales answer.
 *
 * NOTHING IS CONNECTED YET, and the panel now shows that as an empty state
 * rather than as sample numbers. It used to open on plausible view counts and
 * three invented reviews under a small amber "Sample data" badge — anyone who
 * scrolled past the badge read fabricated praise from named customers, one of
 * them carrying a fabricated reply signed by DC Solar. All of that is deleted;
 * see the docstring in `lib/marketing.ts`.
 *
 * THREE LAYOUTS, one per `overview.state`:
 *   unavailable   — one EmptyState. We could not ask, so we say nothing else.
 *   not-connected — an explanation card, then four platform cards reduced to
 *                   name + "Not connected" + Connect. NO metric grid: six
 *                   em-dashes per card is a worse way of saying "no data" than
 *                   not drawing the grid at all.
 *   connected     — the full dashboard: reputation, period, metrics, reviews.
 *
 * The installation-photo strip is mounted ABOVE all three, because those
 * photos come from storage rather than from a platform API and are the only
 * real content this panel has today.
 *
 * Visible to EVERY role: profile views are not money. The Connect and Reply
 * buttons are drawn for admins only, which is cosmetic — RLS is the barrier
 * (supabase/migrations/2026-08-18_marketing.sql).
 */

/** One row of ★★★★☆ at a given size. */
function Stars({ rating, size = 14 }: { rating: number | null; size?: number }) {
  if (rating === null) return <Text style={styles.dash}>—</Text>;
  return (
    <View style={styles.starsRow}>
      {[0, 1, 2, 3, 4].map((i) => {
        // 4.6 → four solid, one half. Anything under a quarter star is empty.
        const remaining = rating - i;
        const name =
          remaining >= 0.75 ? 'star' : remaining >= 0.25 ? 'star-half' : 'star-outline';
        return <Ionicons key={i} name={name} size={size} color={colors.amber} />;
      })}
    </View>
  );
}

const PLATFORM_ICON: Record<MarketingPlatform, 'logo-google' | 'logo-facebook' | 'logo-instagram' | 'restaurant'> = {
  google_business: 'logo-google',
  facebook: 'logo-facebook',
  instagram: 'logo-instagram',
  // Ionicons ships no Yelp mark; the review-site card gets a neutral glyph
  // rather than a wrong logo.
  yelp: 'restaurant',
};

/** Each platform owns a colour from the accent ramp so cards read apart. */
const PLATFORM_TONE: Record<MarketingPlatform, { fg: string; bg: string }> = {
  google_business: { fg: colors.ocean, bg: colors.skySoft },
  facebook: { fg: colors.indigo, bg: colors.indigoSoft },
  instagram: { fg: colors.rose, bg: colors.roseSoft },
  yelp: { fg: colors.coral, bg: colors.coralSoft },
};

/**
 * What connecting a platform actually does, in three lines: what it reads,
 * that it only reads, and why it cannot be switched on today. The long
 * version — OAuth mechanics, the exact Meta permission list — lives in
 * docs/MARKETING_SETUP.md, which is where somebody doing the setup will be.
 */
function connectExplanation(platform: MarketingPlatform): { title: string; body: string } {
  if (platform === 'google_business') {
    return {
      title: 'Connect Google Business Profile',
      body:
        'Pulls your profile views, website clicks, calls, direction requests and reviews into this panel. Read only — it never posts.\n\nNot available yet: Google has to approve an API access request first.\n\nSee docs/MARKETING_SETUP.md.',
    };
  }
  if (platform === 'facebook' || platform === 'instagram') {
    const which = platform === 'facebook' ? 'the page' : 'the business account';
    return {
      title: `Connect ${PLATFORM_LABELS[platform]}`,
      body:
        `Pulls reach, followers and engagement for ${which}, plus reviews and recommendations. Read only — it never posts on your behalf.\n\nNot available yet: Meta needs a developer app Devon creates first.\n\nSee docs/MARKETING_SETUP.md.`,
    };
  }
  return {
    title: 'Connect Yelp',
    body:
      'Pulls the Yelp rating and review count. Yelp does not expose review text to its API, so this card stays deliberately thin.\n\nNot available yet: it needs an API key, stored server-side and never in the app.\n\nSee docs/MARKETING_SETUP.md.',
  };
}

function statusLabel(connection: MarketingConnection): string {
  if (connection.status === 'connected') return 'Connected';
  if (connection.status === 'error') return 'Needs attention';
  return 'Not connected';
}

export function MarketingPanel({ refreshKey = 0 }: { refreshKey?: number }) {
  const role = useRole();
  const isAdmin = role?.isAdmin ?? false;

  const [period, setPeriod] = useState<MarketingPeriod>('28d');
  const [data, setData] = useState<MarketingOverview | null>(null);
  const [loaded, setLoaded] = useState(false);
  /** Explanation sheet: inline card on both platforms, plus a native alert. */
  const [notice, setNotice] = useState<{ title: string; body: string } | null>(null);

  const load = useCallback(async () => {
    setData(await fetchMarketingOverview(period));
    setLoaded(true);
  }, [period]);

  useEffect(() => {
    load();
  }, [load, refreshKey]);

  const openNotice = useCallback((next: { title: string; body: string }) => {
    setNotice(next);
    // Native gets a real alert as well; web has no usable Alert, so the inline
    // card below is the whole story there (same pattern as JobPhotos).
    if (Platform.OS !== 'web') Alert.alert(next.title, next.body);
  }, []);

  const onReply = useCallback(
    (review: MarketingReview) => {
      openNotice({
        title: 'Reply not available yet',
        body:
          `Replying to ${firstName(review.authorName)}'s ${PLATFORM_LABELS[review.platform]} ` +
          'review posts through that platform, which means the connection has ' +
          'to exist first. Connect the platform above and the Reply button ' +
          'starts working — until then, reply from the platform’s own app.',
      });
    },
    [openNotice],
  );

  /**
   * The photo strip is outside every branch below, including loading: it owns
   * its own fetch, and it renders nothing at all when the library is not set
   * up, so it can be mounted unconditionally.
   */
  const withPhotos = (body: React.ReactNode) => (
    <>
      <MarketingPhotos refreshKey={refreshKey} />
      {body}
    </>
  );

  const noticeCard = notice ? (
    <View style={styles.noticeCard}>
      <View style={styles.noticeHeader}>
        <Text style={styles.noticeTitle}>{notice.title}</Text>
        <Pressable onPress={() => setNotice(null)} hitSlop={8}>
          <Ionicons name="close" size={18} color={colors.inkSoft} />
        </Pressable>
      </View>
      <Text style={styles.noticeBody}>{notice.body}</Text>
    </View>
  ) : null;

  const footnote = (
    <Text style={styles.footnote}>
      Reach numbers are visible to everyone — they are not money. Replying and
      connecting are admin-only, and enforced in the database, not here.
    </Text>
  );

  if (!loaded) {
    return withPhotos(<ActivityIndicator style={styles.loading} color={colors.ocean} />);
  }
  if (!data || data.state === 'unavailable') {
    return withPhotos(
      <EmptyState
        icon="cloud-offline"
        title="Marketing isn't available right now"
        body="Pull down to retry."
      />,
    );
  }

  const connectionOf = (platform: MarketingPlatform) =>
    data.connections.find((c) => c.platform === platform) ?? {
      platform,
      status: 'disconnected' as const,
      externalId: null,
      displayName: null,
      connectedAt: null,
      lastSyncedAt: null,
      lastError: null,
    };

  const connectButton = (platform: MarketingPlatform) => (
    <Pressable
      onPress={() => openNotice(connectExplanation(platform))}
      style={({ pressed }) => [styles.connectButton, pressed && styles.pressed]}>
      <Ionicons name="link" size={14} color={colors.ink} />
      <Text style={styles.connectButtonText}>{`Connect ${PLATFORM_SHORT[platform]}`}</Text>
    </Pressable>
  );

  // -------------------------------------------------------------------
  // Nothing connected: explain it once, then four name-only cards.
  // -------------------------------------------------------------------
  if (data.state === 'not-connected') {
    return withPhotos(
      <>
        {noticeCard}

        <Card style={styles.introCard}>
          <Text style={styles.introTitle}>Nothing is connected yet</Text>
          <Text style={styles.introBody}>
            Google, Facebook, Instagram and Yelp each have to be connected
            before their numbers and reviews can appear here. None of them are,
            so there is nothing to report yet — these cards are empty, not zero.
          </Text>
          <Text style={styles.introBody}>
            {isAdmin
              ? 'Tap Connect on a platform to see exactly what it needs first.'
              : 'Devon connects these from this screen once each platform approves access.'}
          </Text>
        </Card>

        {MARKETING_PLATFORMS.map((platform) => {
          const tone = PLATFORM_TONE[platform];
          return (
            <View key={platform} style={styles.card}>
              <View style={styles.platformHeader}>
                <View style={[styles.platformIcon, { backgroundColor: tone.bg }]}>
                  <Ionicons name={PLATFORM_ICON[platform]} size={16} color={tone.fg} />
                </View>
                <View style={styles.platformTitleWrap}>
                  <Text style={styles.platformTitle}>{PLATFORM_LABELS[platform]}</Text>
                  <Text style={styles.platformSub}>Not connected</Text>
                </View>
              </View>
              {isAdmin ? connectButton(platform) : null}
            </View>
          );
        })}

        <Text style={styles.sectionTitle}>Recent reviews</Text>
        <View style={styles.card}>
          <Text style={styles.emptyLead}>No reviews connected</Text>
          <Text style={styles.emptyLeadHint}>
            Reviews land here once a platform is connected.
          </Text>
        </View>

        {footnote}
      </>,
    );
  }

  // -------------------------------------------------------------------
  // Connected: the real dashboard.
  // -------------------------------------------------------------------
  return withPhotos(
    <>
      {noticeCard}

      {/* ---- Reputation ---- */}
      <Text style={styles.sectionTitle}>Reputation</Text>
      <View style={styles.card}>
        <View style={styles.repRow}>
          <View style={styles.repScoreWrap}>
            <Text style={styles.repScore}>
              {data.rating.average !== null ? data.rating.average.toFixed(1) : '—'}
            </Text>
            <Stars rating={data.rating.average} size={16} />
            <Text style={styles.repCount}>
              {data.rating.count === 0
                ? 'No reviews connected'
                : data.rating.count === 1
                  ? '1 Google review'
                  : `${data.rating.count} Google reviews`}
            </Text>
          </View>
          <View style={styles.repIconWrap}>
            <Ionicons name="star" size={26} color={colors.amber} />
          </View>
        </View>

        <View style={styles.divider} />

        <View style={styles.chipRow}>
          {MARKETING_PLATFORMS.map((platform) => {
            const connection = connectionOf(platform);
            const connected = connection.status === 'connected';
            const errored = connection.status === 'error';
            return (
              <View
                key={platform}
                style={[
                  styles.statusChip,
                  connected && styles.statusChipOn,
                  errored && styles.statusChipError,
                ]}>
                <Ionicons
                  name={PLATFORM_ICON[platform]}
                  size={12}
                  color={connected ? colors.mintDeep : errored ? colors.danger : colors.inkSoft}
                />
                <Text
                  style={[
                    styles.statusChipText,
                    connected && styles.statusChipTextOn,
                    errored && styles.statusChipTextError,
                  ]}>
                  {`${PLATFORM_SHORT[platform]} · ${statusLabel(connection)}`}
                </Text>
              </View>
            );
          })}
        </View>
      </View>

      {/* ---- Period ---- */}
      <View style={styles.periodRow}>
        {MARKETING_PERIODS.map((option) => {
          const active = option.key === period;
          return (
            <Pressable
              key={option.key}
              onPress={() => setPeriod(option.key)}
              style={({ pressed }) => [
                styles.periodChip,
                active && styles.periodChipActive,
                pressed && styles.pressed,
              ]}>
              <Text style={[styles.periodChipText, active && styles.periodChipTextActive]}>
                {option.label}
              </Text>
            </Pressable>
          );
        })}
      </View>

      {/* ---- Per-platform metrics ---- */}
      {MARKETING_PLATFORMS.map((platform) => {
        const connection = connectionOf(platform);
        const tone = PLATFORM_TONE[platform];
        const bag = data.metrics[platform];
        return (
          <View key={platform} style={styles.card}>
            <View style={styles.platformHeader}>
              <View style={[styles.platformIcon, { backgroundColor: tone.bg }]}>
                <Ionicons name={PLATFORM_ICON[platform]} size={16} color={tone.fg} />
              </View>
              <View style={styles.platformTitleWrap}>
                <Text style={styles.platformTitle}>{PLATFORM_LABELS[platform]}</Text>
                <Text style={styles.platformSub}>
                  {connection.status === 'connected'
                    ? `${connection.displayName ?? 'Connected'}${
                        connection.lastSyncedAt
                          ? ` · synced ${formatShortDate(connection.lastSyncedAt.slice(0, 10))}`
                          : ''
                      }`
                    : connection.status === 'error'
                      ? (connection.lastError ?? 'Last sync failed')
                      : 'Not connected'}
                </Text>
              </View>
            </View>

            {/* A disconnected platform has no numbers to grid — showing six
                em-dashes reads as broken rather than as "not set up". */}
            {connection.status === 'connected' ? (
              <View style={styles.metricGrid}>
                {PLATFORM_METRICS[platform].map((metric) => (
                  <View key={metric.key} style={styles.metricTile}>
                    <Text style={styles.metricLabel}>{metric.label}</Text>
                    <Text style={styles.metricValue} numberOfLines={1} adjustsFontSizeToFit>
                      {formatMetric(bag[metric.key], metric.key)}
                    </Text>
                  </View>
                ))}
              </View>
            ) : null}

            {connection.status !== 'connected' && isAdmin ? connectButton(platform) : null}
          </View>
        );
      })}

      {/* ---- Reviews ---- */}
      <Text style={styles.sectionTitle}>Recent reviews</Text>
      {data.reviews.length === 0 ? (
        <View style={styles.card}>
          <Text style={styles.emptyLead}>No reviews yet.</Text>
          <Text style={styles.emptyLeadHint}>
            Reviews land here once a platform is connected.
          </Text>
        </View>
      ) : (
        data.reviews.map((review) => (
          <View key={review.key} style={styles.reviewCard}>
            <View style={styles.reviewHeader}>
              <View
                style={[
                  styles.platformIcon,
                  { backgroundColor: PLATFORM_TONE[review.platform].bg },
                ]}>
                <Ionicons
                  name={PLATFORM_ICON[review.platform]}
                  size={14}
                  color={PLATFORM_TONE[review.platform].fg}
                />
              </View>
              <View style={styles.reviewWho}>
                <Text style={styles.reviewAuthor}>{firstName(review.authorName)}</Text>
                <Stars rating={review.rating} />
              </View>
              <Text style={styles.reviewDate}>
                {review.createdAt ? formatShortDate(review.createdAt.slice(0, 10)) : ''}
              </Text>
            </View>
            {review.comment ? (
              <Text style={styles.reviewBody} numberOfLines={3}>
                {review.comment}
              </Text>
            ) : null}
            {review.reply ? (
              <Text style={styles.reviewReply} numberOfLines={2}>
                {`Replied: ${review.reply}`}
              </Text>
            ) : null}
            {isAdmin && !review.reply ? (
              <Pressable
                onPress={() => onReply(review)}
                style={({ pressed }) => [styles.replyButton, pressed && styles.pressed]}>
                <Ionicons name="arrow-undo" size={13} color={colors.ocean} />
                <Text style={styles.replyButtonText}>Reply</Text>
              </Pressable>
            ) : null}
          </View>
        ))
      )}

      {footnote}
    </>,
  );
}

const styles = StyleSheet.create({
  loading: { marginTop: spacing.xl },
  sectionTitle: {
    marginTop: spacing.md,
    fontSize: 13,
    fontWeight: '800',
    color: colors.inkSoft,
    textTransform: 'uppercase',
    letterSpacing: 0.6,
  },
  card: {
    backgroundColor: colors.card,
    borderRadius: radii.md,
    padding: spacing.md,
    gap: spacing.sm,
    marginTop: spacing.sm,
    ...shadows.card,
  },
  divider: { height: 1, backgroundColor: colors.line },
  dash: { color: colors.inkSoft, fontSize: 14, fontWeight: '700' },

  introCard: {
    gap: spacing.sm,
    marginTop: spacing.md,
  },
  introTitle: { color: colors.ink, fontSize: 17, fontWeight: '800' },
  introBody: { color: colors.inkSoft, fontSize: 13, lineHeight: 19, fontWeight: '600' },

  noticeCard: {
    backgroundColor: colors.skySoft,
    borderRadius: radii.md,
    padding: spacing.md,
    gap: spacing.xs,
    marginTop: spacing.sm,
  },
  noticeHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.sm,
  },
  noticeTitle: { color: colors.ink, fontSize: 15, fontWeight: '800', flexShrink: 1 },
  noticeBody: { color: colors.inkSoft, fontSize: 13, lineHeight: 19, fontWeight: '600' },

  repRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  repScoreWrap: { gap: 2 },
  repScore: {
    color: colors.ink,
    fontSize: 34,
    fontWeight: '800',
    fontVariant: ['tabular-nums'],
  },
  repCount: { color: colors.inkSoft, fontSize: 12, fontWeight: '700' },
  repIconWrap: {
    width: 44,
    height: 44,
    borderRadius: radii.pill,
    backgroundColor: colors.amberSoft,
    alignItems: 'center',
    justifyContent: 'center',
  },
  starsRow: { flexDirection: 'row', gap: 1 },

  chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.xs },
  statusChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    backgroundColor: colors.slateSoft,
    borderRadius: radii.pill,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs,
  },
  statusChipOn: { backgroundColor: colors.mintSoft },
  statusChipError: { backgroundColor: colors.coralSoft },
  statusChipText: { color: colors.inkSoft, fontSize: 11, fontWeight: '800' },
  statusChipTextOn: { color: colors.mintDeep },
  statusChipTextError: { color: colors.danger },

  periodRow: { flexDirection: 'row', gap: spacing.xs, marginTop: spacing.md },
  periodChip: {
    backgroundColor: colors.white,
    borderRadius: radii.pill,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs + 2,
    ...shadows.card,
  },
  periodChipActive: { backgroundColor: colors.ocean },
  periodChipText: { color: colors.inkSoft, fontSize: 12, fontWeight: '800' },
  periodChipTextActive: { color: colors.white },

  platformHeader: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  platformIcon: {
    width: 30,
    height: 30,
    borderRadius: radii.sm,
    alignItems: 'center',
    justifyContent: 'center',
  },
  platformTitleWrap: { flex: 1, gap: 1 },
  platformTitle: { color: colors.ink, fontSize: 15, fontWeight: '800' },
  platformSub: { color: colors.inkSoft, fontSize: 11, fontWeight: '600' },

  metricGrid: { flexDirection: 'row', flexWrap: 'wrap', rowGap: spacing.sm },
  metricTile: { width: '33.33%', paddingRight: spacing.sm, gap: 2 },
  metricLabel: {
    color: colors.inkSoft,
    fontSize: 10,
    fontWeight: '800',
    textTransform: 'uppercase',
    letterSpacing: 0.4,
  },
  metricValue: {
    color: colors.ink,
    fontSize: 18,
    fontWeight: '800',
    fontVariant: ['tabular-nums'],
  },

  connectButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.xs,
    backgroundColor: colors.sun,
    borderRadius: radii.pill,
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.md,
    marginTop: spacing.xs,
  },
  connectButtonText: { color: colors.ink, fontSize: 13, fontWeight: '800' },

  reviewCard: {
    backgroundColor: colors.card,
    borderRadius: radii.md,
    padding: spacing.md,
    gap: spacing.xs,
    marginTop: spacing.sm,
    ...shadows.card,
  },
  reviewHeader: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  reviewWho: { flex: 1, gap: 2 },
  reviewAuthor: { color: colors.ink, fontSize: 14, fontWeight: '800' },
  reviewDate: { color: colors.inkSoft, fontSize: 11, fontWeight: '700' },
  reviewBody: { color: colors.inkSoft, fontSize: 13, lineHeight: 18, fontWeight: '600' },
  reviewReply: {
    color: colors.mintDeep,
    fontSize: 12,
    lineHeight: 17,
    fontWeight: '700',
    fontStyle: 'italic',
  },
  replyButton: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'flex-start',
    gap: 4,
    backgroundColor: colors.skySoft,
    borderRadius: radii.pill,
    paddingHorizontal: spacing.sm + 2,
    paddingVertical: spacing.xs,
  },
  replyButtonText: { color: colors.ocean, fontSize: 12, fontWeight: '800' },

  emptyLead: { color: colors.ink, fontSize: 15, fontWeight: '700' },
  emptyLeadHint: { color: colors.inkSoft, fontSize: 12, lineHeight: 17 },
  footnote: {
    marginTop: spacing.md,
    color: colors.inkSoft,
    fontSize: 11,
    lineHeight: 16,
    fontStyle: 'italic',
  },
  pressed: { opacity: 0.7 },
});
