import Ionicons from '@expo/vector-icons/Ionicons';
import { useFocusEffect } from 'expo-router';
import { useCallback, useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { MarketingPanel } from '@/components/MarketingPanel';
import { colors, radii, shadows, spacing } from '@/constants/theme';
import { useRole } from '@/lib/role';
import { fetchSalesData, type SalesData, type SalesFunnel } from '@/lib/sales';

/**
 * Sales tab — two segments over one screen.
 *
 * LEADS is the funnel: Lead → Estimate → Contract. What each person sees is
 * decided by RLS, not by this screen. An admin (Devon, Isaiah, Clark) gets the
 * company view plus a per-rep breakdown. A viewer's queries return only their
 * own leads and only the estimate/contract rows on jobs where they are the
 * sales rep, so the same code renders their own numbers without any filtering
 * here. See lib/sales.ts.
 *
 * MARKETING (added 2026-08-18) is where those leads come from — Google
 * Business Profile, Facebook, Instagram and Yelp. It lives here rather than in
 * its own tab because reach without conversion is a vanity number; the two
 * belong side by side. See components/MarketingPanel.tsx.
 */

type SalesSegment = 'leads' | 'marketing';

const SEGMENTS: { key: SalesSegment; label: string }[] = [
  { key: 'leads', label: 'Leads' },
  { key: 'marketing', label: 'Marketing' },
];

function formatMoney(amount: number): string {
  return `$${Math.round(amount).toLocaleString('en-US')}`;
}

function formatPct(value: number | null): string {
  return value === null ? '—' : `${value.toFixed(0)}%`;
}

function Stat({
  label,
  value,
  hint,
  tone,
}: {
  label: string;
  value: string;
  hint?: string;
  tone?: 'money' | 'rate';
}) {
  return (
    <View style={styles.stat}>
      <Text style={styles.statLabel}>{label}</Text>
      <Text
        style={[
          styles.statValue,
          tone === 'money' && styles.statMoney,
          tone === 'rate' && styles.statRate,
        ]}>
        {value}
      </Text>
      {hint ? <Text style={styles.statHint}>{hint}</Text> : null}
    </View>
  );
}

/** The funnel as three steps, so the drop-off between them is the point. */
function Funnel({ funnel }: { funnel: SalesFunnel }) {
  return (
    <View style={styles.card}>
      <View style={styles.funnelRow}>
        <Stat
          label="Leads"
          value={String(funnel.leads)}
          hint={funnel.leads === 0 ? 'none yet' : `${funnel.leadsWon} won · ${funnel.leadsLost} lost`}
        />
        <Ionicons name="chevron-forward" size={16} color={colors.inkSoft} />
        <Stat
          label="Estimated"
          value={String(funnel.projectsEstimated)}
          hint={formatMoney(funnel.estimatedValue)}
        />
        <Ionicons name="chevron-forward" size={16} color={colors.inkSoft} />
        <Stat
          label="Contracted"
          value={String(funnel.projectsContracted)}
          hint={formatMoney(funnel.contractedValue)}
        />
      </View>

      <View style={styles.divider} />

      <View style={styles.rateRow}>
        <Stat
          label="Lead → Estimate"
          value={formatPct(funnel.leadToEstimatePct)}
          tone="rate"
          hint={funnel.leads === 0 ? 'needs leads' : undefined}
        />
        <Stat
          label="Estimate → Contract"
          value={formatPct(funnel.estimateToContractPct)}
          tone="rate"
          hint={
            funnel.projectsEstimated === 0
              ? 'needs estimates'
              : `${funnel.projectsContracted} of ${funnel.projectsEstimated}`
          }
        />
        <Stat
          label="Lead win rate"
          value={formatPct(funnel.leadWinPct)}
          tone="rate"
          hint={funnel.leads === 0 ? 'needs leads' : undefined}
        />
      </View>
    </View>
  );
}

export default function SalesScreen() {
  const role = useRole();
  const [segment, setSegment] = useState<SalesSegment>('leads');
  const [data, setData] = useState<SalesData | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  // Bumped on pull-to-refresh so the Marketing panel reloads too; it owns its
  // own data (and its own period chips), so it can't ride on `load` above.
  const [refreshKey, setRefreshKey] = useState(0);

  const load = useCallback(async () => {
    setData(await fetchSalesData());
    setLoaded(true);
  }, []);

  useFocusEffect(
    useCallback(() => {
      load();
    }, [load]),
  );

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    try {
      await load();
      setRefreshKey((n) => n + 1);
    } finally {
      setRefreshing(false);
    }
  }, [load]);

  const isAdmin = role?.isAdmin ?? false;

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      <ScrollView
        contentContainerStyle={styles.container}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={onRefresh}
            tintColor={colors.ocean}
          />
        }>
        <Text style={styles.title}>Sales</Text>

        <View style={styles.segmentRow}>
          {SEGMENTS.map((option) => {
            const active = option.key === segment;
            return (
              <Pressable
                key={option.key}
                onPress={() => setSegment(option.key)}
                style={({ pressed }) => [
                  styles.segment,
                  active && styles.segmentActive,
                  pressed && styles.segmentPressed,
                ]}>
                <Text style={[styles.segmentText, active && styles.segmentTextActive]}>
                  {option.label}
                </Text>
              </Pressable>
            );
          })}
        </View>

        {segment === 'marketing' ? (
          <MarketingPanel refreshKey={refreshKey} />
        ) : (
          <>
          <Text style={styles.subtitle}>
            {isAdmin
              ? 'Company-wide funnel, and how each rep is doing.'
              : 'Your leads and the projects you sold.'}
          </Text>

          {!loaded ? (
            <ActivityIndicator style={styles.loading} color={colors.ocean} />
          ) : !data ? (
            <Text style={styles.empty}>
              Couldn&apos;t load sales data. Pull to retry.
            </Text>
          ) : (
            <>
              <Text style={styles.sectionTitle}>
                {isAdmin ? 'Everyone' : 'You'}
              </Text>
              <Funnel funnel={data.overall} />

              {isAdmin && data.byRep.length > 0 ? (
                <>
                  <Text style={styles.sectionTitle}>By rep</Text>
                  {data.byRep.map(({ rep, funnel }) => (
                    <View key={rep.email} style={styles.repCard}>
                      <View style={styles.repHeader}>
                        <Text style={styles.repName}>{rep.displayName}</Text>
                        <Text style={styles.repValue}>
                          {formatMoney(funnel.contractedValue)}
                        </Text>
                      </View>
                      <Text style={styles.repDetail}>
                        {`${funnel.leads} leads · ${funnel.projectsEstimated} estimated · ${funnel.projectsContracted} contracted · ${formatPct(funnel.estimateToContractPct)} close rate`}
                      </Text>
                    </View>
                  ))}
                </>
              ) : null}

              <Text style={styles.sectionTitle}>Leads</Text>
              {data.leads.length === 0 ? (
                <View style={styles.card}>
                  <Text style={styles.emptyLead}>
                    No leads yet.
                  </Text>
                  <Text style={styles.emptyLeadHint}>
                    {isAdmin
                      ? 'Once leads are being entered, lead → estimate and win rates fill in here. Every other number on this page already works.'
                      : 'Leads assigned to you will appear here.'}
                  </Text>
                </View>
              ) : (
                data.leads.map((lead) => (
                  <View key={lead.id} style={styles.repCard}>
                    <View style={styles.repHeader}>
                      <Text style={styles.repName}>{lead.name}</Text>
                      <View style={[styles.statusPill, statusTone(lead.status)]}>
                        <Text style={styles.statusText}>{lead.status}</Text>
                      </View>
                    </View>
                    <Text style={styles.repDetail}>
                      {[
                        lead.address,
                        lead.source ? `via ${lead.source}` : null,
                        lead.estimated_value !== null
                          ? formatMoney(lead.estimated_value)
                          : null,
                        lead.assigned_to ?? 'unassigned',
                      ]
                        .filter(Boolean)
                        .join(' · ')}
                    </Text>
                  </View>
                ))
              )}

              <Text style={styles.footnote}>
                Estimated is what we quoted, Contracted is what was signed. A job
                quoted twice counts once, at its current number.
              </Text>
            </>
          )}
          </>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

function statusTone(status: string) {
  if (status === 'won') return { backgroundColor: colors.mintSoft };
  if (status === 'lost') return { backgroundColor: colors.coralSoft };
  if (status === 'estimating') return { backgroundColor: colors.amberSoft };
  return { backgroundColor: colors.skySoft };
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.cream },
  container: { padding: spacing.lg, paddingBottom: spacing.xl * 2, gap: spacing.sm },
  title: {
    fontFamily: undefined,
    fontSize: 28,
    fontWeight: '800',
    color: colors.ink,
  },
  subtitle: { color: colors.inkSoft, fontSize: 14, marginBottom: spacing.sm },
  // Segmented control: a pill track with the active half filled, so it reads
  // as one control rather than two loose chips.
  segmentRow: {
    flexDirection: 'row',
    backgroundColor: colors.tan,
    borderRadius: radii.pill,
    padding: 3,
    marginTop: spacing.sm,
    marginBottom: spacing.xs,
  },
  segment: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radii.pill,
    paddingVertical: spacing.sm - 2,
  },
  segmentActive: { backgroundColor: colors.white, ...shadows.card },
  segmentPressed: { opacity: 0.7 },
  segmentText: { color: colors.inkSoft, fontSize: 14, fontWeight: '800' },
  segmentTextActive: { color: colors.ink },
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
    ...shadows.card,
  },
  funnelRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs },
  rateRow: { flexDirection: 'row', gap: spacing.sm },
  divider: { height: 1, backgroundColor: colors.line },
  stat: { flex: 1, gap: 2 },
  statLabel: {
    color: colors.inkSoft,
    fontSize: 10,
    fontWeight: '800',
    textTransform: 'uppercase',
    letterSpacing: 0.4,
  },
  statValue: {
    color: colors.ink,
    fontSize: 22,
    fontWeight: '800',
    fontVariant: ['tabular-nums'],
  },
  statMoney: { color: colors.ink },
  statRate: { color: colors.ocean },
  statHint: { color: colors.inkSoft, fontSize: 11, fontWeight: '600' },
  repCard: {
    backgroundColor: colors.card,
    borderRadius: radii.md,
    padding: spacing.md,
    gap: spacing.xs,
    ...shadows.card,
  },
  repHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.sm,
  },
  repName: { color: colors.ink, fontSize: 16, fontWeight: '700', flexShrink: 1 },
  repValue: {
    color: colors.ink,
    fontSize: 16,
    fontWeight: '800',
    fontVariant: ['tabular-nums'],
  },
  repDetail: { color: colors.inkSoft, fontSize: 12, fontWeight: '600' },
  statusPill: {
    borderRadius: radii.pill,
    paddingHorizontal: spacing.sm,
    paddingVertical: 2,
  },
  statusText: {
    fontSize: 11,
    fontWeight: '800',
    color: colors.ink,
    textTransform: 'capitalize',
  },
  loading: { marginTop: spacing.xl },
  empty: { color: colors.inkSoft, marginTop: spacing.lg },
  emptyLead: { color: colors.ink, fontSize: 15, fontWeight: '700' },
  emptyLeadHint: { color: colors.inkSoft, fontSize: 12, lineHeight: 17 },
  footnote: {
    marginTop: spacing.md,
    color: colors.inkSoft,
    fontSize: 11,
    lineHeight: 16,
    fontStyle: 'italic',
  },
});
