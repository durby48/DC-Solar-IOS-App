/**
 * marketing-sync — pull reputation + reach from the platforms into Supabase.
 *
 * NOT DEPLOYED YET, and it cannot be until the owner does the setup in
 * docs/MARKETING_SETUP.md: Google must approve Business Profile API access on
 * a Cloud project, and Meta needs a developer app. Every code path below is
 * written from the published API contracts and has NEVER been executed — the
 * same honest caveat the property-art function carries. Treat the first live
 * run as a test, and watch it.
 *
 * Auth: verify_jwt ON, and the admin role is re-checked SERVER SIDE against
 * the employees table rather than trusted from the client — same shape as
 * property-art. Writes then happen with the service role, which is why the
 * client never needs write access to marketing_* at all.
 *
 * Design rule: a missing secret is a CONFIGURATION state, not an error. Every
 * platform handler returns { ok: false, reason: 'not_connected' } when its
 * secrets are absent, so calling this before setup is finished is harmless and
 * the app keeps showing sample data.
 *
 * ---------------------------------------------------------------------------
 * THE EXACT APIS
 * ---------------------------------------------------------------------------
 *
 * 1. Google Business Profile Performance API  (metrics)
 *    Host: https://businessprofileperformance.googleapis.com
 *    GET /v1/locations/{locationId}:getDailyMetricsTimeSeries
 *      ?dailyMetric=<ONE metric>
 *      &dailyRange.start_date.year=YYYY  &dailyRange.start_date.month=M
 *      &dailyRange.start_date.day=D
 *      &dailyRange.end_date.year=YYYY    &dailyRange.end_date.month=M
 *      &dailyRange.end_date.day=D
 *    dailyMetric values used here (one request each — the endpoint takes a
 *    single metric; `:fetchMultiDailyMetricsTimeSeries` takes several but
 *    returns a different, more awkward envelope):
 *      BUSINESS_IMPRESSIONS_DESKTOP_MAPS
 *      BUSINESS_IMPRESSIONS_DESKTOP_SEARCH
 *      BUSINESS_IMPRESSIONS_MOBILE_MAPS
 *      BUSINESS_IMPRESSIONS_MOBILE_SEARCH
 *      WEBSITE_CLICKS
 *      CALL_CLICKS
 *      BUSINESS_DIRECTION_REQUESTS
 *      BUSINESS_CONVERSATIONS
 *    Response: { timeSeries: { datedValues: [ { date: {year,month,day},
 *               value: "123" } ] } }  — `value` is absent on zero days.
 *    Desktop and mobile are summed into one figure each for Search and Maps;
 *    nobody at DC Solar needs the split, and four tiles for two facts is worse
 *    than two tiles for two facts.
 *
 * 2. Google My Business API  (reviews — a DIFFERENT host and version)
 *    GET https://mybusiness.googleapis.com/v4/accounts/{accountId}/locations/{locationId}/reviews
 *    Response: { reviews: [ { reviewId, reviewer: { displayName },
 *               starRating: 'FIVE'|'FOUR'|…, comment, createTime,
 *               reviewReply: { comment, updateTime } } ] }
 *    starRating is an ENUM WORD, not a number. Hence STAR_WORDS below.
 *
 * 3. Meta Graph — Facebook page insights
 *    GET https://graph.facebook.com/v21.0/{page-id}/insights
 *      ?metric=page_impressions_unique,page_follows,page_post_engagements
 *      &period=day&since=<unix>&until=<unix>&access_token=<page token>
 *    Response: { data: [ { name, period, values: [ { value, end_time } ] } ] }
 *
 * 4. Meta Graph — Instagram insights
 *    GET https://graph.facebook.com/v21.0/{ig-user-id}/insights
 *      ?metric=reach,follower_count,profile_views
 *      &period=day&since=<unix>&until=<unix>&access_token=<token>
 *    Same envelope. Requires an Instagram BUSINESS account linked to the page.
 *
 * 5. Yelp Fusion  (rating + review count only — Yelp does not expose review
 *    text or replies through this API)
 *    GET https://api.yelp.com/v3/businesses/{alias}
 *      Header: Authorization: Bearer <YELP_API_KEY>
 *    Response: { rating, review_count, name }
 *
 * ---------------------------------------------------------------------------
 * SECRETS (set via the Management API — see docs/MARKETING_SETUP.md)
 * ---------------------------------------------------------------------------
 *   GOOGLE_BUSINESS_CLIENT_ID
 *   GOOGLE_BUSINESS_CLIENT_SECRET
 *   GOOGLE_BUSINESS_REFRESH_TOKEN   — offline OAuth token for Devon's account
 *   GOOGLE_BUSINESS_ACCOUNT_ID      — digits only, from accounts.list
 *   GOOGLE_BUSINESS_LOCATION_ID     — digits only, from locations.list
 *   META_PAGE_ID, META_PAGE_TOKEN   — long-lived page access token
 *   META_IG_USER_ID                 — IG business account id (token is shared)
 *   YELP_API_KEY, YELP_BUSINESS_ALIAS
 *
 * Tokens are NOT read from public.marketing_connections — that table is
 * readable by every employee. See the migration's header comment.
 */

import { createClient } from 'jsr:@supabase/supabase-js@2';

const COMPANY = 'dc-solar';
const GRAPH_VERSION = 'v21.0';
const DEFAULT_DAYS = 30;

type Platform = 'google_business' | 'facebook' | 'instagram' | 'yelp';

interface SyncResult {
  ok: boolean;
  platform: Platform;
  /** 'not_connected' when the secrets are absent — a state, not a failure. */
  reason?: string;
  metricsWritten?: number;
  reviewsWritten?: number;
}

interface Payload {
  /** One platform, or omitted for all of them. */
  platform?: Platform;
  /** How far back to pull. Google caps daily metrics at 18 months. */
  days?: number;
}

interface MetricRow {
  company: string;
  platform: Platform;
  metric_date: string;
  metric: string;
  value: number;
  synced_at: string;
}

interface ReviewRow {
  company: string;
  platform: Platform;
  external_id: string;
  author_name: string | null;
  rating: number | null;
  comment: string | null;
  created_at: string | null;
  reply: string | null;
  replied_at: string | null;
  synced_at: string;
}

// Supabase clients are structurally typed here so this file needs no generated
// database types to be valid on its own.
type Admin = ReturnType<typeof createClient>;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function isoDate(d: Date): string {
  const m = `${d.getUTCMonth() + 1}`.padStart(2, '0');
  const day = `${d.getUTCDate()}`.padStart(2, '0');
  return `${d.getUTCFullYear()}-${m}-${day}`;
}

function daysAgo(days: number): Date {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - days);
  return d;
}

// ---------------------------------------------------------------------------
// Google Business Profile
// ---------------------------------------------------------------------------

/** dailyMetric → the app's metric key. Desktop + mobile collapse together. */
const GBP_METRIC_MAP: Record<string, string> = {
  BUSINESS_IMPRESSIONS_DESKTOP_SEARCH: 'profile_views_search',
  BUSINESS_IMPRESSIONS_MOBILE_SEARCH: 'profile_views_search',
  BUSINESS_IMPRESSIONS_DESKTOP_MAPS: 'profile_views_maps',
  BUSINESS_IMPRESSIONS_MOBILE_MAPS: 'profile_views_maps',
  WEBSITE_CLICKS: 'website_clicks',
  CALL_CLICKS: 'calls',
  BUSINESS_DIRECTION_REQUESTS: 'direction_requests',
  BUSINESS_CONVERSATIONS: 'messages',
};

/** starRating comes back as a word, not a number. */
const STAR_WORDS: Record<string, number> = {
  ONE: 1,
  TWO: 2,
  THREE: 3,
  FOUR: 4,
  FIVE: 5,
};

/**
 * Exchange the stored refresh token for a short-lived access token. Google
 * access tokens last an hour, so there is no point caching one between
 * invocations of a function that runs daily.
 */
async function googleAccessToken(): Promise<string | null> {
  const clientId = Deno.env.get('GOOGLE_BUSINESS_CLIENT_ID');
  const clientSecret = Deno.env.get('GOOGLE_BUSINESS_CLIENT_SECRET');
  const refreshToken = Deno.env.get('GOOGLE_BUSINESS_REFRESH_TOKEN');
  if (!clientId || !clientSecret || !refreshToken) return null;

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
    }),
  });
  if (!res.ok) return null;
  const body = (await res.json()) as { access_token?: string };
  return body.access_token ?? null;
}

async function syncGoogleBusiness(admin: Admin, days: number): Promise<SyncResult> {
  const locationId = Deno.env.get('GOOGLE_BUSINESS_LOCATION_ID');
  const accountId = Deno.env.get('GOOGLE_BUSINESS_ACCOUNT_ID');
  if (!locationId || !accountId) {
    return { ok: false, platform: 'google_business', reason: 'not_connected' };
  }
  const token = await googleAccessToken();
  if (!token) return { ok: false, platform: 'google_business', reason: 'not_connected' };

  const auth = { Authorization: `Bearer ${token}` };
  const start = daysAgo(days);
  const end = daysAgo(1); // today is always partial; asking for it invites churn

  // --- metrics -------------------------------------------------------------
  // date → metric key → running total (desktop + mobile land on the same key).
  const totals = new Map<string, Map<string, number>>();

  for (const dailyMetric of Object.keys(GBP_METRIC_MAP)) {
    const params = new URLSearchParams({
      dailyMetric,
      'dailyRange.start_date.year': String(start.getUTCFullYear()),
      'dailyRange.start_date.month': String(start.getUTCMonth() + 1),
      'dailyRange.start_date.day': String(start.getUTCDate()),
      'dailyRange.end_date.year': String(end.getUTCFullYear()),
      'dailyRange.end_date.month': String(end.getUTCMonth() + 1),
      'dailyRange.end_date.day': String(end.getUTCDate()),
    });
    const url =
      `https://businessprofileperformance.googleapis.com/v1/locations/${locationId}` +
      `:getDailyMetricsTimeSeries?${params.toString()}`;

    const res = await fetch(url, { headers: auth });
    if (!res.ok) {
      const detail = await res.text();
      return {
        ok: false,
        platform: 'google_business',
        reason: `performance API ${res.status}: ${detail.slice(0, 200)}`,
      };
    }
    const body = (await res.json()) as {
      timeSeries?: {
        datedValues?: { date?: { year?: number; month?: number; day?: number }; value?: string }[];
      };
    };
    const key = GBP_METRIC_MAP[dailyMetric];
    for (const dated of body.timeSeries?.datedValues ?? []) {
      const y = dated.date?.year;
      const m = dated.date?.month;
      const d = dated.date?.day;
      if (!y || !m || !d) continue;
      const date = `${y}-${`${m}`.padStart(2, '0')}-${`${d}`.padStart(2, '0')}`;
      // A zero day omits `value` entirely — record it as 0 so the series has
      // no holes, which matters when a period average is added later.
      const value = Number(dated.value ?? 0);
      if (!Number.isFinite(value)) continue;
      const forDate = totals.get(date) ?? new Map<string, number>();
      forDate.set(key, (forDate.get(key) ?? 0) + value);
      totals.set(date, forDate);
    }
  }

  const metricRows: MetricRow[] = [];
  const now = new Date().toISOString();
  for (const [date, bag] of totals) {
    for (const [metric, value] of bag) {
      metricRows.push({
        company: COMPANY,
        platform: 'google_business',
        metric_date: date,
        metric,
        value,
        synced_at: now,
      });
    }
  }

  // --- reviews -------------------------------------------------------------
  const reviewRows: ReviewRow[] = [];
  let ratingAverage: number | null = null;
  let ratingCount = 0;

  const reviewsUrl =
    `https://mybusiness.googleapis.com/v4/accounts/${accountId}` +
    `/locations/${locationId}/reviews`;
  const reviewsRes = await fetch(reviewsUrl, { headers: auth });
  if (reviewsRes.ok) {
    const body = (await reviewsRes.json()) as {
      averageRating?: number;
      totalReviewCount?: number;
      reviews?: {
        reviewId?: string;
        reviewer?: { displayName?: string };
        starRating?: string;
        comment?: string;
        createTime?: string;
        reviewReply?: { comment?: string; updateTime?: string };
      }[];
    };
    ratingAverage = typeof body.averageRating === 'number' ? body.averageRating : null;
    ratingCount = body.totalReviewCount ?? body.reviews?.length ?? 0;
    for (const review of body.reviews ?? []) {
      if (!review.reviewId) continue;
      reviewRows.push({
        company: COMPANY,
        platform: 'google_business',
        external_id: review.reviewId,
        author_name: review.reviewer?.displayName ?? null,
        rating: STAR_WORDS[review.starRating ?? ''] ?? null,
        comment: review.comment ?? null,
        created_at: review.createTime ?? null,
        reply: review.reviewReply?.comment ?? null,
        replied_at: review.reviewReply?.updateTime ?? null,
        synced_at: now,
      });
    }
  }

  // The headline rating is stored as a metric on today's date so the app reads
  // it the same way it reads everything else — no special-case column.
  if (ratingAverage !== null) {
    metricRows.push(
      {
        company: COMPANY,
        platform: 'google_business',
        metric_date: isoDate(new Date()),
        metric: 'rating',
        value: ratingAverage,
        synced_at: now,
      },
      {
        company: COMPANY,
        platform: 'google_business',
        metric_date: isoDate(new Date()),
        metric: 'review_count',
        value: ratingCount,
        synced_at: now,
      },
    );
  }

  await writeMetrics(admin, metricRows);
  await writeReviews(admin, reviewRows);
  await markSynced(admin, 'google_business', `locations/${locationId}`, null);

  return {
    ok: true,
    platform: 'google_business',
    metricsWritten: metricRows.length,
    reviewsWritten: reviewRows.length,
  };
}

// ---------------------------------------------------------------------------
// Meta (Facebook page + Instagram business account)
// ---------------------------------------------------------------------------

/** Graph insight name → the app's metric key, per platform. */
const META_METRIC_MAP: Record<Platform, Record<string, string>> = {
  google_business: {},
  facebook: {
    page_impressions_unique: 'page_reach',
    page_follows: 'followers',
    page_post_engagements: 'post_engagement',
  },
  instagram: {
    reach: 'reach',
    follower_count: 'followers',
    profile_views: 'profile_visits',
  },
  yelp: {},
};

async function syncMetaInsights(
  admin: Admin,
  platform: 'facebook' | 'instagram',
  days: number,
): Promise<SyncResult> {
  const token = Deno.env.get('META_PAGE_TOKEN');
  const nodeId =
    platform === 'facebook' ? Deno.env.get('META_PAGE_ID') : Deno.env.get('META_IG_USER_ID');
  if (!token || !nodeId) return { ok: false, platform, reason: 'not_connected' };

  const metrics = Object.keys(META_METRIC_MAP[platform]);
  const since = Math.floor(daysAgo(days).getTime() / 1000);
  const until = Math.floor(Date.now() / 1000);

  const url =
    `https://graph.facebook.com/${GRAPH_VERSION}/${nodeId}/insights?` +
    new URLSearchParams({
      metric: metrics.join(','),
      period: 'day',
      since: String(since),
      until: String(until),
      access_token: token,
    }).toString();

  const res = await fetch(url);
  if (!res.ok) {
    const detail = await res.text();
    // Meta returns 400 with an error envelope for an expired page token, which
    // is the single most likely failure here — record it so the app's chip can
    // say "Needs attention" instead of silently going stale.
    await markSynced(admin, platform, nodeId, `Graph ${res.status}: ${detail.slice(0, 200)}`);
    return { ok: false, platform, reason: `graph ${res.status}` };
  }

  const body = (await res.json()) as {
    data?: { name?: string; values?: { value?: number; end_time?: string }[] }[];
  };

  const now = new Date().toISOString();
  const rows: MetricRow[] = [];
  for (const series of body.data ?? []) {
    const key = META_METRIC_MAP[platform][series.name ?? ''];
    if (!key) continue;
    for (const point of series.values ?? []) {
      const value = Number(point.value ?? 0);
      if (!Number.isFinite(value)) continue;
      // end_time is an ISO timestamp for the END of the day bucket, so the
      // date it describes is the day BEFORE — off by one if taken literally.
      const endTime = point.end_time ? new Date(point.end_time) : null;
      if (!endTime || Number.isNaN(endTime.getTime())) continue;
      endTime.setUTCDate(endTime.getUTCDate() - 1);
      rows.push({
        company: COMPANY,
        platform,
        metric_date: isoDate(endTime),
        metric: key,
        value,
        synced_at: now,
      });
    }
  }

  await writeMetrics(admin, rows);
  await markSynced(admin, platform, nodeId, null);
  return { ok: true, platform, metricsWritten: rows.length };
}

// ---------------------------------------------------------------------------
// Yelp Fusion
// ---------------------------------------------------------------------------

async function syncYelp(admin: Admin): Promise<SyncResult> {
  const key = Deno.env.get('YELP_API_KEY');
  const alias = Deno.env.get('YELP_BUSINESS_ALIAS');
  if (!key || !alias) return { ok: false, platform: 'yelp', reason: 'not_connected' };

  const res = await fetch(`https://api.yelp.com/v3/businesses/${encodeURIComponent(alias)}`, {
    headers: { Authorization: `Bearer ${key}` },
  });
  if (!res.ok) {
    await markSynced(admin, 'yelp', alias, `Fusion ${res.status}`);
    return { ok: false, platform: 'yelp', reason: `fusion ${res.status}` };
  }
  const body = (await res.json()) as { rating?: number; review_count?: number; name?: string };

  const now = new Date().toISOString();
  const today = isoDate(new Date());
  const rows: MetricRow[] = [];
  if (typeof body.rating === 'number') {
    rows.push({
      company: COMPANY,
      platform: 'yelp',
      metric_date: today,
      metric: 'rating',
      value: body.rating,
      synced_at: now,
    });
  }
  if (typeof body.review_count === 'number') {
    rows.push({
      company: COMPANY,
      platform: 'yelp',
      metric_date: today,
      metric: 'review_count',
      value: body.review_count,
      synced_at: now,
    });
  }

  await writeMetrics(admin, rows);
  await markSynced(admin, 'yelp', alias, null, body.name ?? null);
  return { ok: true, platform: 'yelp', metricsWritten: rows.length };
}

// ---------------------------------------------------------------------------
// Writes (service role — RLS is bypassed, which is why the admin check above
// is not optional)
// ---------------------------------------------------------------------------

async function writeMetrics(admin: Admin, rows: MetricRow[]): Promise<void> {
  if (rows.length === 0) return;
  // Chunked: a 90-day pull across eight GBP metrics is ~720 rows, and a single
  // giant upsert is the kind of thing that times out on a bad day.
  const size = 500;
  for (let i = 0; i < rows.length; i += size) {
    await admin
      .from('marketing_metrics')
      .upsert(rows.slice(i, i + size), {
        onConflict: 'company,platform,metric_date,metric',
      });
  }
}

async function writeReviews(admin: Admin, rows: ReviewRow[]): Promise<void> {
  if (rows.length === 0) return;
  await admin
    .from('marketing_reviews')
    .upsert(rows, { onConflict: 'company,platform,external_id' });
}

async function markSynced(
  admin: Admin,
  platform: Platform,
  externalId: string,
  error: string | null,
  displayName: string | null = null,
): Promise<void> {
  await admin.from('marketing_connections').upsert(
    {
      company: COMPANY,
      platform,
      status: error ? 'error' : 'connected',
      external_id: externalId,
      ...(displayName ? { display_name: displayName } : {}),
      connected_at: new Date().toISOString(),
      last_synced_at: new Date().toISOString(),
      last_error: error,
    },
    { onConflict: 'company,platform' },
  );
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

Deno.serve(async (req: Request) => {
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405);

  const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  const admin = createClient(supabaseUrl, serviceKey);

  // --- caller must be a company admin --------------------------------------
  // verify_jwt is ON, so a token exists by the time we get here — but a VALID
  // token only proves someone is signed in, and every customer-portal login is
  // signed in too. The role check is the actual gate.
  const authHeader = req.headers.get('Authorization') ?? '';
  const jwt = authHeader.replace(/^Bearer\s+/i, '');
  if (!jwt) return json({ error: 'Missing Authorization header' }, 401);

  const { data: userData, error: userErr } = await admin.auth.getUser(jwt);
  const email = userData?.user?.email?.toLowerCase();
  if (userErr || !email) return json({ error: 'Not signed in' }, 401);

  const { data: employee } = await admin
    .from('employees')
    .select('role')
    .eq('email', email)
    .maybeSingle();
  const role = (employee as { role?: string } | null)?.role;
  if (role !== 'owner' && role !== 'operator') return json({ error: 'Admins only' }, 403);

  // --- input ---------------------------------------------------------------
  let payload: Payload = {};
  try {
    payload = (await req.json()) as Payload;
  } catch {
    // An empty body means "sync everything", which is what a cron call sends.
    payload = {};
  }
  const days = Math.min(Math.max(payload.days ?? DEFAULT_DAYS, 1), 540);
  const wanted: Platform[] = payload.platform
    ? [payload.platform]
    : ['google_business', 'facebook', 'instagram', 'yelp'];

  // --- run -----------------------------------------------------------------
  const results: SyncResult[] = [];
  for (const platform of wanted) {
    try {
      if (platform === 'google_business') {
        results.push(await syncGoogleBusiness(admin, days));
      } else if (platform === 'facebook' || platform === 'instagram') {
        results.push(await syncMetaInsights(admin, platform, days));
      } else {
        results.push(await syncYelp(admin));
      }
    } catch (e) {
      // One dead platform must not take the other three down with it.
      results.push({
        ok: false,
        platform,
        reason: e instanceof Error ? e.message : 'sync failed',
      });
    }
  }

  const anyConnected = results.some((r) => r.ok);
  return json({
    ok: anyConnected,
    ...(anyConnected ? {} : { reason: 'not_connected' }),
    days,
    results,
  });
});
