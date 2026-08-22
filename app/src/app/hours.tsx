import Ionicons from '@expo/vector-icons/Ionicons';
import { Stack, useFocusEffect } from 'expo-router';
import { useCallback, useMemo, useState } from 'react';
import {
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';

import { colors, radii, shadows, spacing } from '@/constants/theme';
import {
  fetchHoursData,
  formatPayrollDate,
  listPayrollPeriods,
  payrollState,
  summarizePeriod,
  type HoursData,
  type PayrollState,
} from '@/lib/payroll';
import { useRole } from '@/lib/role';

function formatHours(hours: number): string {
  const rounded = Math.round(hours * 10) / 10;
  return `${Number.isInteger(rounded) ? rounded : rounded.toFixed(1)} h`;
}

function formatMoney(amount: number): string {
  return `$${amount.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** Headline under the period dates, driven by where we are in the cycle. */
function stateLabel(state: PayrollState, pre: boolean): string {
  if (pre) return 'Paid before tracking';
  switch (state) {
    case 'current':
      return 'Current payroll — still accruing';
    case 'awaiting-submit':
      return 'Closed — not submitted yet';
    case 'submitted':
      return 'Submitted — awaiting payday';
    case 'paid':
      return 'Paid';
  }
}

function stateChipStyle(state: PayrollState) {
  switch (state) {
    case 'current':
      return { bg: colors.skySoft, fg: colors.ocean };
    case 'awaiting-submit':
      return { bg: colors.amberSoft, fg: colors.amberDeep };
    case 'submitted':
      return { bg: colors.indigoSoft, fg: colors.indigoDeep };
    case 'paid':
      return { bg: colors.mintSoft, fg: colors.mintDeep };
  }
}

export default function HoursScreen() {
  const role = useRole();
  const [data, setData] = useState<HoursData | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [openNames, setOpenNames] = useState<Set<string>>(new Set());

  const periods = useMemo(() => listPayrollPeriods(), []);
  // Default to the current (last) period.
  const [periodIndex, setPeriodIndex] = useState(periods.length - 1);
  const period = periods[periodIndex];
  const state = payrollState(period);
  const isPaid = state === 'paid';

  const load = useCallback(async () => {
    setData(role?.isAdmin ? await fetchHoursData() : null);
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

  const overview = useMemo(
    () => (data ? summarizePeriod(data, period) : null),
    [data, period],
  );

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
    <>
      {/* Root-stack header, same convention as every more/* screen: the
          title is declared in the body, the back arrow comes from
          app/_layout.tsx. */}
      <Stack.Screen options={{ title: 'Hours' }} />
      <ScrollView
        style={styles.safe}
        contentContainerStyle={styles.container}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={onRefresh}
            tintColor={colors.ocean}
          />
        }>
        {!loaded ? null : !role ? (
          placeholder('Sign in to see crew hours.')
        ) : !role.isAdmin ? (
          placeholder('Hours are available to owners and operators.')
        ) : !overview ? (
          placeholder('Hours are not available right now.')
        ) : (
          <>
            <View style={styles.periodCard}>
              <View style={styles.periodPagerRow}>
                <Pressable
                  onPress={() => setPeriodIndex((i) => Math.max(0, i - 1))}
                  disabled={periodIndex === 0}
                  hitSlop={8}
                  style={({ pressed }) => [
                    styles.pagerButton,
                    periodIndex === 0 && styles.pagerButtonDisabled,
                    pressed && styles.buttonPressed,
                  ]}>
                  <Ionicons name="chevron-back" size={18} color={colors.ink} />
                </Pressable>
                <View style={styles.periodLabelWrap}>
                  <Text style={styles.periodDates}>{period.label}</Text>
                  <View
                    style={[
                      styles.stateChip,
                      { backgroundColor: stateChipStyle(state).bg },
                    ]}>
                    <Text style={[styles.stateChipText, { color: stateChipStyle(state).fg }]}>
                      {stateLabel(state, period.pre)}
                    </Text>
                  </View>
                </View>
                <Pressable
                  onPress={() => setPeriodIndex((i) => Math.min(periods.length - 1, i + 1))}
                  disabled={periodIndex === periods.length - 1}
                  hitSlop={8}
                  style={({ pressed }) => [
                    styles.pagerButton,
                    periodIndex === periods.length - 1 && styles.pagerButtonDisabled,
                    pressed && styles.buttonPressed,
                  ]}>
                  <Ionicons name="chevron-forward" size={18} color={colors.ink} />
                </Pressable>
              </View>
              <View style={styles.overviewGrid}>
                <View style={styles.overviewTile}>
                  <Text style={styles.tileLabel}>Crew hours</Text>
                  <Text style={styles.tileValue} numberOfLines={1} adjustsFontSizeToFit>
                    {formatHours(overview.totalPeriodHours)}
                  </Text>
                </View>
                <View style={styles.overviewTile}>
                  <Text style={styles.tileLabel}>{isPaid ? 'Payroll paid' : 'Payroll due'}</Text>
                  <Text style={styles.tileValue} numberOfLines={1} adjustsFontSizeToFit>
                    {formatMoney(overview.totalPeriodPay)}
                  </Text>
                </View>
              </View>
              {period.pre ? (
                <Text style={styles.periodHint}>
                  Paid through the old spreadsheet, before the app tracked hours.
                </Text>
              ) : (
                <View style={styles.cycleRow}>
                  <View style={styles.cycleItem}>
                    <Text style={styles.cycleLabel}>Submit</Text>
                    <Text style={styles.cycleValue}>{formatPayrollDate(period.submitOn)}</Text>
                  </View>
                  <View style={styles.cycleDivider} />
                  <View style={styles.cycleItem}>
                    <Text style={styles.cycleLabel}>Payday</Text>
                    <Text style={[styles.cycleValue, styles.cyclePayday]}>
                      {formatPayrollDate(period.payOn)}
                    </Text>
                  </View>
                </View>
              )}
              <Text style={styles.periodHint}>
                Two-week periods. Payroll is submitted the Wednesday after a period closes and
                paid the Friday after. Use the arrows to review past payrolls.
              </Text>
            </View>

            {overview.employees.length === 0
              ? placeholder('No hours in this period.')
              : overview.employees.map((emp) => {
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
                            <Text style={styles.tileLabel}>
                              {period.current ? 'This payroll' : 'Period'}
                            </Text>
                            <Text style={styles.tileValue} numberOfLines={1} adjustsFontSizeToFit>
                              {formatHours(emp.periodHours)}
                            </Text>
                          </View>
                          <View style={styles.employeeTile}>
                            <Text style={styles.tileLabel}>
                              {isPaid ? 'Paid' : 'Pay due'}
                            </Text>
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
                          <View style={styles.jobHeaderRow}>
                            <Text style={styles.jobColLabel}>Job</Text>
                            <View style={styles.jobNumbers}>
                              <Text style={[styles.jobColLabel, styles.jobColPaid]}>
                                Paid before
                              </Text>
                              <Text style={[styles.jobColLabel, styles.jobColPeriod]}>
                                {period.current ? 'This payroll' : 'This period'}
                              </Text>
                            </View>
                          </View>
                          {emp.jobs.map((job) => (
                            <View key={job.jobId ?? 'none'} style={styles.jobRow}>
                              <View style={styles.jobChip}>
                                <Text style={styles.jobChipText}>{job.label}</Text>
                              </View>
                              <View style={styles.jobNumbers}>
                                <Text style={[styles.jobPaidHours, styles.jobColPaid]}>
                                  {job.paidHours > 0 ? formatHours(job.paidHours) : '—'}
                                </Text>
                                <Text style={[styles.jobHours, styles.jobColPeriod]}>
                                  {job.periodHours > 0 ? formatHours(job.periodHours) : '—'}
                                </Text>
                              </View>
                            </View>
                          ))}
                          <Text style={styles.jobListHint}>
                            "Paid before" = hours on the job from earlier, already-paid periods —
                            carry-over jobs show both sides.
                          </Text>
                        </View>
                      ) : null}
                    </View>
                  );
                })}
          </>
        )}
      </ScrollView>
    </>
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
  periodCard: {
    backgroundColor: colors.sunLight,
    borderRadius: radii.md,
    padding: spacing.md,
    marginBottom: spacing.md,
    gap: spacing.sm,
    ...shadows.card,
  },
  periodPagerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.sm,
  },
  pagerButton: {
    width: 32,
    height: 32,
    borderRadius: radii.sm,
    backgroundColor: colors.white,
    alignItems: 'center',
    justifyContent: 'center',
    ...shadows.card,
  },
  pagerButtonDisabled: {
    opacity: 0.35,
  },
  periodLabelWrap: {
    flex: 1,
    alignItems: 'center',
    gap: 1,
  },
  periodDates: {
    color: colors.ink,
    fontSize: 16,
    fontWeight: '800',
  },
  periodSub: {
    color: colors.inkSoft,
    fontSize: 11,
    fontWeight: '700',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  periodHint: {
    color: colors.inkSoft,
    fontSize: 12,
    fontWeight: '600',
  },
  stateChip: {
    borderRadius: radii.pill,
    paddingHorizontal: spacing.sm + 2,
    paddingVertical: 3,
    marginTop: 2,
  },
  stateChipText: {
    fontSize: 11,
    fontWeight: '800',
  },
  cycleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.canvas,
    borderRadius: radii.sm,
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.md,
    marginTop: spacing.sm,
  },
  cycleItem: {
    flex: 1,
    gap: 2,
  },
  cycleDivider: {
    width: StyleSheet.hairlineWidth,
    alignSelf: 'stretch',
    backgroundColor: colors.line,
    marginHorizontal: spacing.sm,
  },
  cycleLabel: {
    color: colors.inkSoft,
    fontSize: 10,
    fontWeight: '800',
    textTransform: 'uppercase',
    letterSpacing: 0.6,
  },
  cycleValue: {
    color: colors.ink,
    fontSize: 15,
    fontWeight: '800',
  },
  cyclePayday: {
    color: colors.mintDeep,
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
  jobHeaderRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  jobColLabel: {
    color: colors.inkSoft,
    fontSize: 10,
    fontWeight: '700',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  jobNumbers: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  jobColPaid: {
    width: 84,
    textAlign: 'right',
  },
  jobColPeriod: {
    width: 92,
    textAlign: 'right',
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
    flexShrink: 1,
  },
  jobChipText: {
    color: colors.ocean,
    fontSize: 12,
    fontWeight: '800',
  },
  jobPaidHours: {
    color: colors.inkSoft,
    fontSize: 14,
    fontWeight: '700',
    fontVariant: ['tabular-nums'],
  },
  jobHours: {
    color: colors.ink,
    fontSize: 14,
    fontWeight: '800',
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
