/**
 * Marketing: reputation and reach across Google Business Profile, Facebook,
 * Instagram and Yelp.
 *
 * NOTHING IS CONNECTED YET, AND THE APP NO LONGER PRETENDS OTHERWISE. This
 * module used to answer every failure with a sample dataset — plausible view
 * counts and three invented five-star reviews from named people, one of them
 * carrying a fabricated reply signed by DC Solar. Reviews are the one thing a
 * contractor cannot fake even in a demo, so all of it is gone. An empty
 * overview is returned instead, and the panel says which kind of empty it is.
 *
 * THREE STATES, NOT A FLAG. `state` is the whole answer:
 *   connected     — the query ran and at least one platform row exists.
 *   not-connected — the query ran and `marketing_connections` is empty. The
 *                   feature is simply not set up; four zeroed cards would read
 *                   as "your marketing got no views", which is a different and
 *                   false claim.
 *   unavailable   — nobody is signed in, or the request itself failed
 *                   (missing table, RLS refusal, dead network).
 *
 * DEGRADES, NEVER THROWS. Every one of those paths returns a valid overview.
 * A marketing dashboard is not worth a crash on a roof.
 *
 * VISIBILITY. Every company member reads these numbers — profile views are not
 * money, and there is nothing here to leak the way finance_entries once did.
 * Writes are admin-only at the DB level (see
 * supabase/migrations/2026-08-18_marketing.sql). `role.isAdmin` in the UI only
 * decides what buttons are drawn; RLS is the barrier.
 */

import { supabase } from '@/lib/supabase';

const COMPANY = 'dc-solar';

export type MarketingPlatform = 'google_business' | 'facebook' | 'instagram' | 'yelp';

export const MARKETING_PLATFORMS: MarketingPlatform[] = [
  'google_business',
  'facebook',
  'instagram',
  'yelp',
];

export const PLATFORM_LABELS: Record<MarketingPlatform, string> = {
  google_business: 'Google Business Profile',
  facebook: 'Facebook',
  instagram: 'Instagram',
  yelp: 'Yelp',
};

/** Short form for chips, where the full name does not fit. */
export const PLATFORM_SHORT: Record<MarketingPlatform, string> = {
  google_business: 'Google',
  facebook: 'Facebook',
  instagram: 'Instagram',
  yelp: 'Yelp',
};

export type MarketingPeriod = '7d' | '28d' | '90d';

export const MARKETING_PERIODS: { key: MarketingPeriod; label: string; days: number }[] = [
  { key: '7d', label: '7 days', days: 7 },
  { key: '28d', label: '28 days', days: 28 },
  { key: '90d', label: '90 days', days: 90 },
];

export function periodDays(period: MarketingPeriod): number {
  return MARKETING_PERIODS.find((p) => p.key === period)?.days ?? 28;
}

export type ConnectionStatus = 'connected' | 'disconnected' | 'error';

export interface MarketingConnection {
  platform: MarketingPlatform;
  status: ConnectionStatus;
  /** GBP location resource name, FB page id, IG user id, Yelp alias. */
  externalId: string | null;
  displayName: string | null;
  connectedAt: string | null;
  lastSyncedAt: string | null;
  lastError: string | null;
}

export interface MarketingReview {
  /** Stable key for lists: platform + the platform's own review id. */
  key: string;
  platform: MarketingPlatform;
  authorName: string | null;
  rating: number | null;
  comment: string | null;
  createdAt: string | null;
  reply: string | null;
  repliedAt: string | null;
}

/**
 * Summed (or latest, for level metrics) values keyed by metric name. A metric
 * the platform does not provide is simply absent — the UI renders "—" for it
 * rather than a zero, because "no data" and "zero views" are different facts.
 */
export type MetricBag = Partial<Record<string, number>>;

/**
 * Why the overview looks the way it does. See the module docstring — the UI
 * branches on this, and "no data" and "couldn't ask" are different sentences.
 */
export type MarketingState = 'connected' | 'not-connected' | 'unavailable';

export interface MarketingOverview {
  state: MarketingState;
  period: MarketingPeriod;
  connections: MarketingConnection[];
  metrics: Record<MarketingPlatform, MetricBag>;
  reviews: MarketingReview[];
  /** Headline rating: Google's, since that is the one customers search. */
  rating: { average: number | null; count: number };
}

/**
 * Metrics that are a LEVEL, not a flow. Follower counts and star ratings do
 * not add up over a period — summing 28 daily snapshots of "1,240 followers"
 * would report 34,720 followers. These take the most recent snapshot instead.
 */
const LEVEL_METRICS = new Set(['followers', 'rating', 'review_count']);

/** Which metric keys each platform card shows, in display order. */
export const PLATFORM_METRICS: Record<
  MarketingPlatform,
  { key: string; label: string }[]
> = {
  google_business: [
    { key: 'profile_views_search', label: 'Views · Search' },
    { key: 'profile_views_maps', label: 'Views · Maps' },
    { key: 'website_clicks', label: 'Website clicks' },
    { key: 'calls', label: 'Calls' },
    { key: 'direction_requests', label: 'Directions' },
    { key: 'messages', label: 'Messages' },
  ],
  facebook: [
    { key: 'page_reach', label: 'Page reach' },
    { key: 'followers', label: 'Followers' },
    { key: 'post_engagement', label: 'Post engagement' },
  ],
  instagram: [
    { key: 'reach', label: 'Reach' },
    { key: 'followers', label: 'Followers' },
    { key: 'profile_visits', label: 'Profile visits' },
  ],
  yelp: [
    { key: 'rating', label: 'Rating' },
    { key: 'review_count', label: 'Reviews' },
  ],
};

function emptyMetrics(): Record<MarketingPlatform, MetricBag> {
  return {
    google_business: {},
    facebook: {},
    instagram: {},
    yelp: {},
  };
}

function isoDaysAgo(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() - days);
  const m = `${d.getMonth() + 1}`.padStart(2, '0');
  const day = `${d.getDate()}`.padStart(2, '0');
  return `${d.getFullYear()}-${m}-${day}`;
}

// ---------------------------------------------------------------------------
// Empty overview
// ---------------------------------------------------------------------------

/**
 * A real, honest nothing: every platform disconnected, no metrics, no
 * reviews, no headline rating. `state` carries the reason, and the panel
 * turns that into either "nothing is connected yet" or "marketing isn't
 * available right now".
 *
 * `rating.count` is 0 but `rating.average` is null on purpose — zero reviews
 * is a fact, an average of zero stars is not.
 */
export function emptyOverview(
  period: MarketingPeriod,
  state: MarketingState,
): MarketingOverview {
  return {
    state,
    period,
    connections: MARKETING_PLATFORMS.map((platform) => ({
      platform,
      status: 'disconnected' as ConnectionStatus,
      externalId: null,
      displayName: null,
      connectedAt: null,
      lastSyncedAt: null,
      lastError: null,
    })),
    metrics: emptyMetrics(),
    reviews: [],
    rating: { average: null, count: 0 },
  };
}

// ---------------------------------------------------------------------------
// Live fetch
// ---------------------------------------------------------------------------

interface ConnectionRow {
  platform: string;
  status: string;
  external_id: string | null;
  display_name: string | null;
  connected_at: string | null;
  last_synced_at: string | null;
  last_error: string | null;
}

interface MetricRow {
  platform: string;
  metric_date: string;
  metric: string;
  value: number | string;
}

interface ReviewRow {
  platform: string;
  external_id: string;
  author_name: string | null;
  rating: number | null;
  comment: string | null;
  created_at: string | null;
  reply: string | null;
  replied_at: string | null;
}

const isPlatform = (value: string): value is MarketingPlatform =>
  (MARKETING_PLATFORMS as string[]).includes(value);

const isStatus = (value: string): value is ConnectionStatus =>
  value === 'connected' || value === 'disconnected' || value === 'error';

/**
 * Everything the Marketing panel needs, for one period.
 *
 * Four ways out, and each one names itself. Signed out, a failed query, or a
 * thrown exception are all `unavailable` — from the roof they are the same
 * fact, "we couldn't ask". An empty `marketing_connections` table is
 * `not-connected`, which is deliberately NOT the same answer: the query
 * worked, the feature just isn't set up.
 */
export async function fetchMarketingOverview(
  period: MarketingPeriod,
): Promise<MarketingOverview> {
  try {
    const { data: session } = await supabase.auth.getSession();
    if (!session.session) return emptyOverview(period, 'unavailable');

    const since = isoDaysAgo(periodDays(period));

    const [connRes, metricRes, reviewRes] = await Promise.all([
      supabase
        .from('marketing_connections')
        .select(
          'platform, status, external_id, display_name, connected_at, last_synced_at, last_error',
        )
        .eq('company', COMPANY),
      supabase
        .from('marketing_metrics')
        .select('platform, metric_date, metric, value')
        .eq('company', COMPANY)
        .gte('metric_date', since),
      supabase
        .from('marketing_reviews')
        .select(
          'platform, external_id, author_name, rating, comment, created_at, reply, replied_at',
        )
        .eq('company', COMPANY)
        .order('created_at', { ascending: false })
        .limit(10),
    ]);

    // Any error at all — missing table (42P01), RLS refusal, network — is the
    // same answer to the person holding the phone.
    if (connRes.error || metricRes.error || reviewRes.error) {
      return emptyOverview(period, 'unavailable');
    }

    const connRows = (connRes.data ?? []) as unknown as ConnectionRow[];
    if (connRows.length === 0) return emptyOverview(period, 'not-connected');

    const connections: MarketingConnection[] = MARKETING_PLATFORMS.map((platform) => {
      const row = connRows.find((r) => r.platform === platform);
      return {
        platform,
        status: row && isStatus(row.status) ? row.status : 'disconnected',
        externalId: row?.external_id ?? null,
        displayName: row?.display_name ?? null,
        connectedAt: row?.connected_at ?? null,
        lastSyncedAt: row?.last_synced_at ?? null,
        lastError: row?.last_error ?? null,
      };
    });

    // Sum flows, take the newest snapshot for levels.
    const metrics = emptyMetrics();
    const levelStamp = new Map<string, string>();
    for (const row of (metricRes.data ?? []) as unknown as MetricRow[]) {
      if (!isPlatform(row.platform)) continue;
      const value = Number(row.value);
      if (!Number.isFinite(value)) continue;
      const bag = metrics[row.platform];
      if (LEVEL_METRICS.has(row.metric)) {
        const stampKey = `${row.platform}:${row.metric}`;
        const prev = levelStamp.get(stampKey);
        if (prev === undefined || row.metric_date >= prev) {
          levelStamp.set(stampKey, row.metric_date);
          bag[row.metric] = value;
        }
      } else {
        bag[row.metric] = (bag[row.metric] ?? 0) + value;
      }
    }

    const reviews: MarketingReview[] = ((reviewRes.data ?? []) as unknown as ReviewRow[])
      .filter((r) => isPlatform(r.platform))
      .map((r) => ({
        key: `${r.platform}:${r.external_id}`,
        platform: r.platform as MarketingPlatform,
        authorName: r.author_name,
        rating: r.rating != null ? Number(r.rating) : null,
        comment: r.comment,
        createdAt: r.created_at,
        reply: r.reply,
        repliedAt: r.replied_at,
      }));

    return {
      state: 'connected',
      period,
      connections,
      metrics,
      reviews,
      // Google is the headline because it is the one customers search. Yelp's
      // own rating still shows on the Yelp card.
      rating: {
        average: metrics.google_business.rating ?? null,
        count: metrics.google_business.review_count ?? 0,
      },
    };
  } catch {
    return emptyOverview(period, 'unavailable');
  }
}

/** Only the first name — a review list is not a place to publish full names. */
export function firstName(name: string | null): string {
  const trimmed = (name ?? '').trim();
  if (trimmed === '') return 'Someone';
  return trimmed.split(/\s+/)[0];
}

/** 1,163 — plain integers; ratings keep one decimal. */
export function formatMetric(
  value: number | undefined,
  metric: string,
): string {
  if (value === undefined || !Number.isFinite(value)) return '—';
  if (metric === 'rating') return value.toFixed(1);
  return Math.round(value).toLocaleString('en-US');
}
