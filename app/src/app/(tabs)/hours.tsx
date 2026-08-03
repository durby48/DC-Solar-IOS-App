import Ionicons from '@expo/vector-icons/Ionicons';
import { useFocusEffect } from 'expo-router';
import { useCallback, useState } from 'react';
import {
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { colors, radii, shadows, spacing } from '@/constants/theme';
import { formatShortDate } from '@/lib/dates';
import { fetchHoursOverview, type HoursOverview } from '@/lib/payroll';
import { useRole } from '@/lib/role';

function formatHours(hours: number): string {
  const rounded = Math.round(hours * 10) / 10;
  return `${Number.isInteger(rounded) ? rounded : rounded.toFixed(1)} h`;
}

function formatMoney(amount: number): string {
  return `$${amount.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export default function HoursScreen() {
  const role = useRole();
  const [data, setData] = useState<HoursOverview | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [openNames, setOpenNames] = useState<Set<string>>(new Set());

  const load = useCallback(async () => {
    setData(role?.isAdmin ? await fetchHoursOverview() : null);
    setLoaded(true);
  }, [role]);

  useFocusEffect(
    useCallback(() => {
      load();
    }, [load]),
  );

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    try {
      await load();
    } finally {
      setRefreshing(false);
    }
  }, [load]);

  const toggle = (name: string) => {
    setOpenNames((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  };

  const placeholder = (message: string) => (
    <View style={styles.placeholderCard}>
      <Ionicons name="time" size={22} color={colors.inkSoft} />
      <Text style={styles.placeholderText}>{message}</Text>
    </View>
  );

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
        <Text style={styles.title}>Hours</Text>

        {!loaded ? null : !role ? (
          placeholder('Sign in to see crew hours.')
        ) : !role.isAdmin ? (
          placeholder('Hours are available to owners and operators.')
        ) : !data ? (
          placeholder('Hours are not available right now.')
        ) : (
          <>
            <View style={styles.periodCard}>
              <View style={styles.periodHeaderRow}>
                <Text style={styles.periodLabel}>This payroll</Text>
                <Text style={styles.periodDates}>
                  {formatShortDate(data.period.start)} – {formatShortDate(data.period.end)}
                </Text>
              </View>
              <View style={styles.overviewGrid}>
                <View style={styles.overviewTile}>
                  <Text style={styles.tileLabel}>Crew hours</Text>
                  <Text style={styles.tileValue} numberOfLines={1} adjustsFontSizeToFit>
                    {formatHours(data.totalPeriodHours)}
                  </Text>
                </View>
                <View style={styles.overviewTile}>
                  <Text style={styles.tileLabel}>Payroll</Text>
                  <Text style={styles.tileValue} numberOfLines={1} adjustsFontSizeToFit>
                    {formatMoney(data.totalPeriodPay)}
                  </Text>
                </View>
              </View>
              <Text style={styles.periodHint}>
                Hours before {formatShortDate(data.period.start)} are paid out. Periods run every
                two weeks.
              </Text>
            </View>

            {data.employees.length === 0
              ? placeholder('No hours logged yet this year.')
              : data.employees.map((emp) => {
                  const open = openNames.has(emp.name);
                  return (
                    <View key={emp.name} style={styles.employeeCard}>
                      <Pressable
                        onPress={() => toggle(emp.name)}
                        style={({ pressed }) => [pressed && styles.buttonPressed]}>
                        <View style={styles.employeeHeaderRow}>
                          <Text style={styles.employeeName}>{emp.name}</Text>
                          <Ionicons
                            name={open ? 'chevron-down' : 'chevron-forward'}
                            size={16}
                            color={colors.inkSoft}
                          />
                        </View>
                        <View style={styles.overviewGrid}>
                          <View style={styles.employeeTile}>
                            <Text style={styles.tileLabel}>This payroll</Text>
                            <Text style={styles.tileValue} numberOfLines={1} adjustsFontSizeToFit>
                              {formatHours(emp.periodHours)}
                            </Text>
                          </View>
                          <View style={styles.employeeTile}>
                            <Text style={styles.tileLabel}>Pay</Text>
                            <Text style={styles.tileValue} numberOfLines={1} adjustsFontSizeToFit>
                              {formatMoney(emp.periodPay)}
                              {emp.periodPayIncomplete ? '*' : ''}
                            </Text>
                          </View>
                          <View style={styles.employeeTile}>
                            <Text style={styles.tileLabel}>YTD</Text>
                            <Text style={styles.tileValue} numberOfLines={1} adjustsFontSizeToFit>
                              {formatHours(emp.ytdHours)}
                            </Text>
                          </View>
                        </View>
                        {emp.periodPayIncomplete ? (
                          <Text style={styles.rateWarning}>
                            * some hours have no pay rate — actual pay is higher.
                          </Text>
                        ) : null}
                      </Pressable>
                      {open ? (
                        <View style={styles.jobList}>
                          {emp.jobs.map((job) => (
                            <View key={job.jobId ?? 'none'} style={styles.jobRow}>
                              <View style={styles.jobChip}>
                                <Text style={styles.jobChipText}>{job.label}</Text>
                              </View>
                              <Text style={styles.jobHours}>{formatHours(job.hours)}</Text>
                            </View>
                          ))}
                          <Text style={styles.jobListHint}>Hours per job, year to date.</Text>
                        </View>
                      ) : null}
                    </View>
                  );
                })}
          </>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: {
    flex: 1,
    backgroundColor: colors.cream,
  },
  container: {
    padding: spacing.lg,
    paddingBottom: spacing.xl,
  },
  title: {
    color: colors.ink,
    fontSize: 28,
    fontWeight: '800',
    marginBottom: spacing.md,
  },
  periodCard: {
    backgroundColor: colors.sunLight,
    borderRadius: radii.md,
    padding: spacing.md,
    marginBottom: spacing.md,
    gap: spacing.sm,
    ...shadows.card,
  },
  periodHeaderRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  periodLabel: {
    color: colors.ink,
    fontSize: 14,
    fontWeight: '800',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  periodDates: {
    color: colors.ink,
    fontSize: 14,
    fontWeight: '700',
  },
  periodHint: {
    color: colors.inkSoft,
    fontSize: 12,
    fontWeight: '600',
  },
  overviewGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    rowGap: spacing.md,
  },
  overviewTile: {
    width: '50%',
    gap: 2,
    paddingRight: spacing.sm,
  },
  employeeTile: {
    width: '33.33%',
    gap: 2,
    paddingRight: spacing.sm,
  },
  tileLabel: {
    color: colors.inkSoft,
    fontSize: 11,
    fontWeight: '700',
    textTransform: 'uppercase',
    letterSpacing: 0.6,
  },
  tileValue: {
    color: colors.ink,
    fontSize: 20,
    fontWeight: '800',
    fontVariant: ['tabular-nums'],
  },
  employeeCard: {
    backgroundColor: colors.white,
    borderRadius: radii.md,
    padding: spacing.md,
    marginBottom: spacing.md,
    gap: spacing.sm,
    ...shadows.card,
  },
  employeeHeaderRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: spacing.sm,
  },
  employeeName: {
    color: colors.ink,
    fontSize: 17,
    fontWeight: '800',
  },
  rateWarning: {
    color: colors.inkSoft,
    fontSize: 11,
    fontWeight: '600',
    marginTop: spacing.xs,
  },
  jobList: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.tan,
    paddingTop: spacing.sm,
    gap: spacing.xs,
  },
  jobRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  jobChip: {
    backgroundColor: colors.skySoft,
    borderRadius: radii.pill,
    paddingHorizontal: spacing.sm,
    paddingVertical: 2,
  },
  jobChipText: {
    color: colors.ocean,
    fontSize: 12,
    fontWeight: '800',
  },
  jobHours: {
    color: colors.ink,
    fontSize: 14,
    fontWeight: '700',
    fontVariant: ['tabular-nums'],
  },
  jobListHint: {
    color: colors.inkSoft,
    fontSize: 11,
    fontWeight: '600',
    marginTop: spacing.xs,
  },
  buttonPressed: {
    opacity: 0.7,
  },
  placeholderCard: {
    backgroundColor: colors.skySoft,
    borderRadius: radii.md,
    padding: spacing.lg,
    alignItems: 'center',
    gap: spacing.xs,
  },
  placeholderText: {
    color: colors.inkSoft,
    fontSize: 14,
    fontWeight: '600',
    textAlign: 'center',
  },
});
