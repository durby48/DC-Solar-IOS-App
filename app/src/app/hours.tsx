import Ionicons from '@expo/vector-icons/Ionicons';
import { Stack, useFocusEffect } from 'expo-router';
import { useCallback, useMemo, useState } from 'react';
import { StyleSheet, View } from 'react-native';

import {
  AnimatedPressable,
  AppText,
  Card,
  Chip,
  EmptyState,
  FadeInUp,
  Pill,
  Screen,
  SkeletonList,
  StatTile,
} from '@/components/ui';
import { colors, radii, spacing } from '@/constants/theme';
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

/**
 * Where the period sits in the cycle, in color. Unchanged meanings — this
 * map now feeds `<Pill>` instead of a local `styles.stateChip`.
 */
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
    <Card>
      <EmptyState icon="time" title={message} />
    </Card>
  );

  const chipStyle = stateChipStyle(state);

  return (
    <>
      {/* Root-stack header, same convention as every more/* screen: the
          title is declared in the body, the back arrow comes from
          app/_layout.tsx. */}
      <Stack.Screen options={{ title: 'Hours' }} />
      <Screen edges={[]} refreshing={refreshing} onRefresh={onRefresh}>
        {!loaded ? (
          <SkeletonList count={4} height={110} />
        ) : !role ? (
          placeholder('Sign in to see crew hours.')
        ) : !role.isAdmin ? (
          placeholder('Hours are available to owners and operators.')
        ) : !overview ? (
          placeholder('Hours are not available right now.')
        ) : (
          <>
            <Card tone="sunk" style={styles.periodCard}>
              <View style={styles.periodPagerRow}>
                <Chip
                  label="Prev"
                  icon="chevron-back"
                  tone="olive"
                  disabled={periodIndex === 0}
                  onPress={() => setPeriodIndex((i) => Math.max(0, i - 1))}
                />
                <View style={styles.periodLabelWrap}>
                  <AppText variant="heading" align="center">
                    {period.label}
                  </AppText>
                  <Pill
                    label={stateLabel(state, period.pre)}
                    bg={chipStyle.bg}
                    fg={chipStyle.fg}
                    style={styles.stateChip}
                  />
                </View>
                <Chip
                  label="Next"
                  icon="chevron-forward"
                  tone="olive"
                  disabled={periodIndex === periods.length - 1}
                  onPress={() => setPeriodIndex((i) => Math.min(periods.length - 1, i + 1))}
                />
              </View>

              <View style={styles.tileRow}>
                <StatTile
                  label="Crew hours"
                  value={overview.totalPeriodHours}
                  suffix=" h"
                  decimals={1}
                  tone="olive"
                  countUp
                />
                <StatTile
                  label={isPaid ? 'Payroll paid' : 'Payroll due'}
                  value={overview.totalPeriodPay}
                  prefix="$"
                  decimals={2}
                  tone={5}
                  countUp
                />
              </View>

              {period.pre ? (
                <AppText variant="caption" color={colors.textMuted}>
                  Paid through the old spreadsheet, before the app tracked hours.
                </AppText>
              ) : (
                <View style={styles.cycleRow}>
                  <View style={styles.cycleItem}>
                    <AppText variant="section" color={colors.textMuted}>
                      Submit
                    </AppText>
                    <AppText variant="bodyStrong">{formatPayrollDate(period.submitOn)}</AppText>
                  </View>
                  <View style={styles.cycleDivider} />
                  <View style={styles.cycleItem}>
                    <AppText variant="section" color={colors.textMuted}>
                      Payday
                    </AppText>
                    <AppText variant="bodyStrong" color={colors.mintDeep}>
                      {formatPayrollDate(period.payOn)}
                    </AppText>
                  </View>
                </View>
              )}

              <AppText variant="caption" color={colors.textMuted}>
                Two-week periods. Payroll is submitted the Wednesday after a period closes and
                paid the Friday after. Use the arrows to review past payrolls.
              </AppText>
            </Card>

            {overview.employees.length === 0
              ? placeholder('No hours in this period.')
              : overview.employees.map((emp, index) => {
                  const open = openNames.has(emp.name);
                  return (
                    <FadeInUp key={emp.name} index={index}>
                      <Card style={styles.employeeCard}>
                        <AnimatedPressable
                          onPress={() => toggle(emp.name)}
                          haptic="tapLight"
                          scaleTo={0.995}
                          accessibilityRole="button"
                          accessibilityState={{ expanded: open }}
                          accessibilityLabel={emp.name}>
                          <View style={styles.employeeHeaderRow}>
                            <AppText variant="heading">{emp.name}</AppText>
                            <Ionicons
                              name={open ? 'chevron-down' : 'chevron-forward'}
                              size={16}
                              color={colors.textMuted}
                            />
                          </View>
                          <View style={styles.overviewGrid}>
                            <View style={styles.employeeTile}>
                              <AppText variant="section" color={colors.textMuted}>
                                {period.current ? 'This payroll' : 'Period'}
                              </AppText>
                              <AppText
                                variant="numeric"
                                style={styles.tileValue}
                                numberOfLines={1}
                                adjustsFontSizeToFit>
                                {formatHours(emp.periodHours)}
                              </AppText>
                            </View>
                            <View style={styles.employeeTile}>
                              <AppText variant="section" color={colors.textMuted}>
                                {isPaid ? 'Paid' : 'Pay due'}
                              </AppText>
                              <AppText
                                variant="numeric"
                                style={styles.tileValue}
                                numberOfLines={1}
                                adjustsFontSizeToFit>
                                {formatMoney(emp.periodPay)}
                                {emp.periodPayIncomplete ? '*' : ''}
                              </AppText>
                            </View>
                            <View style={styles.employeeTile}>
                              <AppText variant="section" color={colors.textMuted}>
                                YTD
                              </AppText>
                              <AppText
                                variant="numeric"
                                style={styles.tileValue}
                                numberOfLines={1}
                                adjustsFontSizeToFit>
                                {formatHours(emp.ytdHours)}
                              </AppText>
                            </View>
                          </View>
                          {emp.periodPayIncomplete ? (
                            <AppText
                              variant="caption"
                              color={colors.textMuted}
                              style={styles.rateWarning}>
                              * some hours have no pay rate — actual pay is higher.
                            </AppText>
                          ) : null}
                        </AnimatedPressable>

                        {open ? (
                          <View style={styles.jobList}>
                            <View style={styles.jobHeaderRow}>
                              <AppText variant="section" color={colors.textMuted}>
                                Job
                              </AppText>
                              <View style={styles.jobNumbers}>
                                <AppText
                                  variant="section"
                                  color={colors.textMuted}
                                  style={styles.jobColPaid}>
                                  Paid before
                                </AppText>
                                <AppText
                                  variant="section"
                                  color={colors.textMuted}
                                  style={styles.jobColPeriod}>
                                  {period.current ? 'This payroll' : 'This period'}
                                </AppText>
                              </View>
                            </View>
                            {emp.jobs.map((job) => (
                              <View key={job.jobId ?? 'none'} style={styles.jobRow}>
                                <Pill
                                  label={job.label}
                                  bg={colors.oliveSoft}
                                  fg={colors.oliveDeep}
                                  style={styles.jobChip}
                                />
                                <View style={styles.jobNumbers}>
                                  <AppText
                                    variant="caption"
                                    color={colors.textMuted}
                                    style={[styles.jobNumber, styles.jobColPaid]}>
                                    {job.paidHours > 0 ? formatHours(job.paidHours) : '—'}
                                  </AppText>
                                  <AppText
                                    variant="bodyStrong"
                                    style={[styles.jobNumber, styles.jobColPeriod]}>
                                    {job.periodHours > 0 ? formatHours(job.periodHours) : '—'}
                                  </AppText>
                                </View>
                              </View>
                            ))}
                            <AppText
                              variant="caption"
                              color={colors.textMuted}
                              style={styles.jobListHint}>
                              &quot;Paid before&quot; = hours on the job from earlier,
                              already-paid periods — carry-over jobs show both sides.
                            </AppText>
                          </View>
                        ) : null}
                      </Card>
                    </FadeInUp>
                  );
                })}
          </>
        )}
      </Screen>
    </>
  );
}

const styles = StyleSheet.create({
  periodCard: {
    gap: spacing.sm,
  },
  periodPagerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.sm,
  },
  periodLabelWrap: {
    flex: 1,
    alignItems: 'center',
    gap: 2,
  },
  stateChip: {
    marginTop: 2,
  },
  tileRow: {
    flexDirection: 'row',
    gap: spacing.sm,
  },
  cycleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.surface,
    borderRadius: radii.sm,
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.md,
    marginTop: spacing.xs,
  },
  cycleItem: {
    flex: 1,
    gap: 2,
  },
  cycleDivider: {
    width: StyleSheet.hairlineWidth,
    alignSelf: 'stretch',
    backgroundColor: colors.border,
    marginHorizontal: spacing.sm,
  },
  overviewGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    rowGap: spacing.md,
  },
  employeeTile: {
    width: '33.33%',
    gap: 2,
    paddingRight: spacing.sm,
  },
  tileValue: {
    fontSize: 20,
    lineHeight: 25,
  },
  employeeCard: {
    gap: spacing.sm,
  },
  employeeHeaderRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: spacing.sm,
  },
  rateWarning: {
    marginTop: spacing.xs,
  },
  jobList: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
    paddingTop: spacing.sm,
    gap: spacing.xs,
  },
  jobHeaderRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
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
    flexShrink: 1,
  },
  jobNumber: {
    fontVariant: ['tabular-nums'],
  },
  jobListHint: {
    marginTop: spacing.xs,
  },
});
