/**
 * Marketing: reputation and reach across Google Business Profile, Facebook,
 * Instagram and Yelp.
 *
 * NOTHING IS CONNECTED YET. Google Business Profile API access must be
 * requested on a Google Cloud project and approved by Google, and Meta needs a
 * developer app Devon creates — docs/MARKETING_SETUP.md walks through both.
 * Until then this module returns a clearly-labelled MOCK dataset so the panel
 * is fully testable in the web build, and the UI says so on screen.
 *
 * DEGRADES, NEVER THROWS. Missing tables, an RLS refusal, a signed-out
 * session, or a dead network all resolve to the same thing: mock data with
 * `isMock: true`. A marketing dashboard is not worth a crash on a roof.
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

export interface MarketingOverview {
  /** True when these numbers are sample data, not from a live connection. */
  isMock: boolean;
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
// Mock dataset
// ---------------------------------------------------------------------------

/**
 * Plausible numbers for a small Kansas City solar contractor, scaled by the
 * period so switching 7d → 90d visibly moves the flow metrics and leaves the
 * level metrics (followers, rating) alone. Deliberately NOT round numbers —
 * a demo full of 100s looks fake and gets mistaken for a bug.
 */
function mockOverview(period: MarketingPeriod): MarketingOverview {
  const days = periodDays(period);
  const scale = days / 28;
  const flow = (perMonth: number) => Math.max(1, Math.round(perMonth * scale));

  return {
    isMock: true,
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
    metrics: {
      google_business: {
        profile_views_search: flow(842),
        profile_views_maps: flow(1163),
        website_clicks: flow(97),
        calls: flow(41),
        direction_requests: flow(58),
        messages: flow(11),
      },
      facebook: {
        page_reach: flow(2340),
        followers: 486,
        post_engagement: flow(214),
      },
      instagram: {
        reach: flow(1712),
        followers: 623,
        profile_visits: flow(188),
      },
      yelp: {
        rating: 4.5,
        review_count: 12,
      },
    },
    reviews: [
      {
        key: 'mock-1',
        platform: 'google_business',
        authorName: 'Marcus',
        rating: 5,
        comment:
          'Crew pulled all 34 panels for our new roof and had them back up the next day. Showed up when they said they would, which is more than I can say for the roofer.',
        createdAt: isoDaysAgo(4),
        reply: null,
        repliedAt: null,
      },
      {
        key: 'mock-2',
        platform: 'facebook',
        authorName: 'Angela',
        rating: 5,
        comment:
          'Devon walked me through the whole critter guard install and sent photos when it was done. Squirrels are officially evicted.',
        createdAt: isoDaysAgo(12),
        reply: 'Thanks Angela — glad the squirrels finally got the message!',
        repliedAt: isoDaysAgo(11),
      },
      {
        key: 'mock-3',
        platform: 'yelp',
        authorName: 'Trent',
        rating: 4,
        comment:
          'Good work and fair price. Took a couple days longer than quoted because of the rain, but they kept me posted the whole time.',
        createdAt: isoDaysAgo(23),
        reply: null,
        repliedAt: null,
      },
    ],
    rating: { average: 4.8, count: 27 },
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
 * Falls back to `mockOverview` — same shape, `isMock: true` — when the tables
 * are missing, RLS refuses, nobody is signed in, or no platform has ever been
 * connected. That last case matters: an empty connections table means the
 * feature has not been set up, and showing four zeroed cards would read as
 * "your marketing got no views" rather than "nothing is plugged in yet".
 */
export async function fetchMarketingOverview(
  period: MarketingPeriod,
): Promise<MarketingOverview> {
  try {
    const { data: session } = await supabase.auth.getSession();
    if (!session.session) return mockOverview(period);

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
    if (connRes.error || metricRes.error || reviewRes.error) return mockOverview(period);

    const connRows = (connRes.data ?? []) as unknown as ConnectionRow[];
    if (connRows.length === 0) return mockOverview(period);

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
      isMock: false,
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
    return mockOverview(period);
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
