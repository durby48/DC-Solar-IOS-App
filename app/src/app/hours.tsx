import Ionicons from '@expo/vector-icons/Ionicons';
import { Stack, router, useFocusEffect } from 'expo-router';
import { useCallback, useMemo, useState } from 'react';
import { ActivityIndicator, StyleSheet, TextInput, View } from 'react-native';

import { LogHoursSheet } from '@/components/LogHoursSheet';
import {
  AnimatedPressable,
  AppText,
  Button,
  Card,
  Chip,
  EmptyState,
  FadeInUp,
  Pill,
  Screen,
  SkeletonList,
  StatTile,
} from '@/components/ui';
import { colors, hubColors, radii, spacing } from '@/constants/theme';
import {
  fetchHoursData,
  fetchPayrollRuns,
  formatPayrollDate,
  listPayrollPeriods,
  payrollState,
  recordPayrollRun,
  runsForPeriod,
  summarizePeriod,
  type HoursData,
  type PayrollRun,
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

/** Human Resources hub accent — the Hours tab lives under HR on Home. */
const hr = hubColors.hr;

/**
 * Where the period sits in the cycle, in color. Unchanged meanings — this
 * map now feeds `<Pill>` instead of a local `styles.stateChip`. "Current"
 * wears the HR green (was ocean); the other three keep their stage colours.
 */
function stateChipStyle(state: PayrollState) {
  switch (state) {
    case 'current':
      return { bg: hr.bg, fg: hr.deep };
    case 'awaiting-submit':
      return { bg: colors.amberSoft, fg: colors.amberDeep };
    case 'submitted':
      return { bg: colors.indigoSoft, fg: colors.indigoDeep };
    case 'paid':
      return { bg: colors.mintSoft, fg: colors.mintDeep };
  }
}

/** Prev/Next period pager in the HR green (the kit `Chip` has no HR tone). */
function PagerChip({
  label,
  icon,
  disabled,
  onPress,
}: {
  label: string;
  icon: 'chevron-back' | 'chevron-forward';
  disabled: boolean;
  onPress: () => void;
}) {
  return (
    <AnimatedPressable
      onPress={onPress}
      disabled={disabled}
      haptic="tapLight"
      scaleTo={0.94}
      accessibilityRole="button"
      accessibilityState={{ disabled }}
      accessibilityLabel={label}
      style={({ pressed }) => [
        styles.pagerChip,
        { backgroundColor: pressed ? hr.fg : hr.bg },
        disabled && styles.pagerChipDisabled,
      ]}>
      {({ pressed }: { pressed: boolean }) => {
        const fg = pressed ? colors.textInverse : hr.deep;
        return (
          <>
            {icon === 'chevron-back' ? <Ionicons name={icon} size={14} color={fg} /> : null}
            <AppText variant="caption" color={fg}>
              {label}
            </AppText>
            {icon === 'chevron-forward' ? <Ionicons name={icon} size={14} color={fg} /> : null}
          </>
        );
      }}
    </AnimatedPressable>
  );
}

export default function HoursScreen() {
  const role = useRole();
  const [data, setData] = useState<HoursData | null>(null);
  const [loaded, setLoaded] = useState(false);
  // Recorded Gusto runs, one per receipt (see payroll_runs); runsForPeriod
  // splits them into the period's regular run + its off-cycle corrections.
  const [runs, setRuns] = useState<PayrollRun[]>([]);
  const [runFormOpen, setRunFormOpen] = useState(false);
  // The run being corrected (null = recording a new one) and its kind.
  const [editingRun, setEditingRun] = useState<PayrollRun | null>(null);
  const [runKind, setRunKind] = useState<PayrollRun['kind']>('regular');
  const [runPayday, setRunPayday] = useState('');
  const [runGross, setRunGross] = useState('');
  const [runWithdrawn, setRunWithdrawn] = useState('');
  const [runReceiptId, setRunReceiptId] = useState('');
  const [runSaving, setRunSaving] = useState(false);
  const [runMessage, setRunMessage] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [openNames, setOpenNames] = useState<Set<string>>(new Set());
  // The multi-employee "Log hours" sheet (LogHoursSheet) — one save writes a
  // row per ticked person.
  const [logOpen, setLogOpen] = useState(false);
  const [logMessage, setLogMessage] = useState<string | null>(null);

  const periods = useMemo(() => listPayrollPeriods(), []);
  // Default to the current (last) period.
  const [periodIndex, setPeriodIndex] = useState(periods.length - 1);
  const period = periods[periodIndex];
  const state = payrollState(period);
  const isPaid = state === 'paid';

  const load = useCallback(async () => {
    if (role?.isAdmin) {
      const [hoursData, runList] = await Promise.all([fetchHoursData(), fetchPayrollRuns()]);
      setData(hoursData);
      setRuns(runList);
    } else {
      setData(null);
    }
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

  const { regular: recordedRun, offCycle: offCycleRuns } = useMemo(
    () => runsForPeriod(runs, period),
    [runs, period],
  );

  /**
   * Open the form to correct `run`, or to record a new run of `kind`. A new
   * regular run is prefilled from what the screen already knows: Gusto pays
   * on the period's payday, and gross is the period's hours × rates. An
   * off-cycle run pays one person, so its gross starts blank. Withdrawn
   * comes off the pay receipt / Chase and has no in-app source.
   */
  const openRunForm = (run: PayrollRun | null, kind: PayrollRun['kind']) => {
    setEditingRun(run);
    setRunKind(run?.kind ?? kind);
    setRunPayday(run?.payday ?? period.payOn ?? '');
    setRunGross(
      run
        ? String(run.gross_wages)
        : kind === 'regular'
          ? (overview?.totalPeriodPay ?? 0).toFixed(2)
          : '',
    );
    setRunWithdrawn(run ? String(run.total_withdrawn) : '');
    setRunReceiptId(run?.receipt_id ?? '');
    setRunMessage(null);
    setRunFormOpen(true);
  };

  const saveRun = async () => {
    const gross = Number(runGross);
    const withdrawn = Number(runWithdrawn);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(runPayday.trim())) {
      setRunMessage('Payday must be YYYY-MM-DD.');
      return;
    }
    if (!Number.isFinite(gross) || gross < 0 || !Number.isFinite(withdrawn) || withdrawn <= 0) {
      setRunMessage('Enter the gross wages and the total withdrawn from the bank.');
      return;
    }
    setRunSaving(true);
    setRunMessage(null);
    const result = await recordPayrollRun({
      // Editing keeps the run's own dates: the 08/18–08/28 transition run
      // sits inside the app's Aug 18–31 period and must not be stretched.
      id: editingRun?.id,
      periodStart: editingRun?.period_start ?? period.start,
      periodEnd: editingRun?.period_end ?? period.end,
      payday: runPayday.trim(),
      grossWages: gross,
      totalWithdrawn: withdrawn,
      receiptId: runReceiptId.trim() || null,
      kind: runKind,
    });
    setRunSaving(false);
    if (result.ok) {
      setRunFormOpen(false);
      await load();
    } else {
      setRunMessage(result.message);
    }
  };

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

  const openJob = (jobId: string) => {
    router.push({ pathname: '/job/[id]', params: { id: jobId, focus: 'hours' } });
  };

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
                <PagerChip
                  label="Prev"
                  icon="chevron-back"
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
                <PagerChip
                  label="Next"
                  icon="chevron-forward"
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

              {/* Recorded Gusto run for this period — the Financials labor
                  figure uses the ACTUAL withdrawal instead of the tax
                  estimate once this exists (see payroll_runs). */}
              {!period.pre ? (
                runFormOpen ? (
                  <View style={styles.runForm}>
                    <AppText variant="section" color={colors.textMuted}>
                      {editingRun ? 'Correct payroll run' : 'Record payroll run'}
                    </AppText>
                    <AppText variant="caption" color={colors.textMuted}>
                      From the Gusto pay receipt. “Total withdrawn” is the run&apos;s whole
                      withdrawal — net pay plus every tax, both sides. A regular run pays the
                      whole crew and marks the period paid; an off-cycle run (a correction for
                      one person, a schedule transition) counts in labor but never marks
                      anyone else&apos;s hours paid.
                    </AppText>
                    <View style={styles.runKindRow}>
                      <Chip
                        label="Regular"
                        tone="olive"
                        selected={runKind === 'regular'}
                        onPress={() => setRunKind('regular')}
                      />
                      <Chip
                        label="Off-cycle"
                        tone="olive"
                        selected={runKind === 'off_cycle'}
                        onPress={() => setRunKind('off_cycle')}
                      />
                    </View>
                    <AppText variant="section" color={colors.textMuted} style={styles.runLabel}>
                      Payday (YYYY-MM-DD)
                    </AppText>
                    <TextInput
                      value={runPayday}
                      onChangeText={setRunPayday}
                      placeholder="2026-08-24"
                      placeholderTextColor={colors.textMuted}
                      autoCapitalize="none"
                      style={styles.runInput}
                    />
                    <AppText variant="section" color={colors.textMuted} style={styles.runLabel}>
                      Gross wages
                    </AppText>
                    <TextInput
                      value={runGross}
                      onChangeText={setRunGross}
                      placeholder="0.00"
                      placeholderTextColor={colors.textMuted}
                      keyboardType="decimal-pad"
                      style={styles.runInput}
                    />
                    <AppText variant="section" color={colors.textMuted} style={styles.runLabel}>
                      Total withdrawn by the bank
                    </AppText>
                    <TextInput
                      value={runWithdrawn}
                      onChangeText={setRunWithdrawn}
                      placeholder="0.00"
                      placeholderTextColor={colors.textMuted}
                      keyboardType="decimal-pad"
                      style={styles.runInput}
                    />
                    <AppText variant="section" color={colors.textMuted} style={styles.runLabel}>
                      Gusto receipt ID (optional)
                    </AppText>
                    <TextInput
                      value={runReceiptId}
                      onChangeText={setRunReceiptId}
                      placeholder="65640bd2-…"
                      placeholderTextColor={colors.textMuted}
                      autoCapitalize="none"
                      style={styles.runInput}
                    />
                    {runMessage ? (
                      <AppText variant="caption" color={colors.danger}>
                        {runMessage}
                      </AppText>
                    ) : null}
                    <View style={styles.runButtons}>
                      <Button
                        label="Cancel"
                        size="sm"
                        variant="secondary"
                        onPress={() => setRunFormOpen(false)}
                        disabled={runSaving}
                      />
                      {runSaving ? (
                        <ActivityIndicator color={colors.accentPrimary} />
                      ) : (
                        <Button label="Save run" size="sm" onPress={() => void saveRun()} />
                      )}
                    </View>
                  </View>
                ) : (
                  <>
                    {recordedRun ? (
                      <View style={styles.runRecordedRow}>
                        <View style={styles.runRecordedText}>
                          <AppText variant="caption" color={colors.mintDeep}>
                            {`Run recorded — ${formatMoney(recordedRun.total_withdrawn)} withdrawn, paid ${formatPayrollDate(recordedRun.payday)}`}
                          </AppText>
                          {recordedRun.receipt_id ? (
                            <AppText variant="caption" color={colors.textMuted} numberOfLines={1}>
                              {`Receipt ${recordedRun.receipt_id}`}
                            </AppText>
                          ) : null}
                        </View>
                        <Chip
                          label="Edit"
                          tone="olive"
                          onPress={() => openRunForm(recordedRun, 'regular')}
                        />
                      </View>
                    ) : null}
                    {/* Off-cycle runs sit beside the regular one: they are real
                        withdrawals (Financials counts them) but pay one person,
                        so they never stand in for the crew's run. */}
                    {offCycleRuns.map((run) => (
                      <View key={run.id} style={styles.runRecordedRow}>
                        <View style={styles.runRecordedText}>
                          <AppText variant="caption" color={colors.textMuted}>
                            {`Off-cycle run — ${formatMoney(run.total_withdrawn)} withdrawn, paid ${formatPayrollDate(run.payday)}`}
                          </AppText>
                          {run.receipt_id ? (
                            <AppText variant="caption" color={colors.textMuted} numberOfLines={1}>
                              {`Receipt ${run.receipt_id}`}
                            </AppText>
                          ) : null}
                        </View>
                        <Chip label="Edit" tone="olive" onPress={() => openRunForm(run, 'off_cycle')} />
                      </View>
                    ))}
                    <View style={styles.runButtons}>
                      <Button
                        label="Record off-cycle run"
                        size="sm"
                        variant="secondary"
                        onPress={() => openRunForm(null, 'off_cycle')}
                      />
                      {!recordedRun ? (
                        <Button
                          label="Record payroll run"
                          size="sm"
                          variant="secondary"
                          onPress={() => openRunForm(null, 'regular')}
                        />
                      ) : null}
                    </View>
                  </>
                )
              ) : null}
            </Card>

            {/* Manual logging — one sheet, any number of people, one save.
                Replaces "write the hours, pick a person, save, repeat". */}
            {logOpen ? (
              <LogHoursSheet
                title="Log hours"
                onCancel={() => {
                  setLogOpen(false);
                  setLogMessage(null);
                }}
                onSaved={(outcome) => {
                  const people = outcome.rows.filter((r) => r.ok).length;
                  setLogMessage(
                    `${formatHours(outcome.hours)} logged for ${people} ${people === 1 ? 'person' : 'people'} on ${formatPayrollDate(outcome.occurredOn)}.`,
                  );
                  if (outcome.ok) setLogOpen(false);
                  void load();
                }}
              />
            ) : (
              <View style={styles.logRow}>
                <Button
                  label="Log hours"
                  icon="add-circle"
                  size="sm"
                  variant="secondary"
                  onPress={() => {
                    setLogMessage(null);
                    setLogOpen(true);
                  }}
                />
                {logMessage ? (
                  <AppText variant="caption" color={colors.success} style={styles.logMessage}>
                    {logMessage}
                  </AppText>
                ) : (
                  <AppText variant="caption" color={colors.textMuted} style={styles.logMessage}>
                    Tick several people to log the same hours for each in one save.
                  </AppText>
                )}
              </View>
            )}

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
                                {job.jobId ? (
                                  // The DC-26### chip is a link: opens the job
                                  // scrolled to its hours section.
                                  <AnimatedPressable
                                    onPress={() => openJob(job.jobId as string)}
                                    haptic="tapLight"
                                    scaleTo={0.96}
                                    hitSlop={6}
                                    accessibilityRole="link"
                                    accessibilityLabel={`Open ${job.label} hours`}
                                    style={({ pressed }) => [
                                      styles.jobLink,
                                      { backgroundColor: pressed ? hr.fg : hr.bg },
                                    ]}>
                                    {({ pressed }: { pressed: boolean }) => (
                                      <>
                                        <AppText
                                          variant="caption"
                                          color={pressed ? colors.textInverse : hr.deep}
                                          numberOfLines={1}
                                          style={styles.jobLinkText}>
                                          {job.label}
                                        </AppText>
                                        <Ionicons
                                          name="chevron-forward"
                                          size={12}
                                          color={pressed ? colors.textInverse : hr.fg}
                                        />
                                      </>
                                    )}
                                  </AnimatedPressable>
                                ) : (
                                  <Pill
                                    label={job.label}
                                    bg={colors.slateSoft}
                                    fg={colors.slateDeep}
                                    style={styles.jobChip}
                                  />
                                )}
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
                              Tap a job to open it at its hours.
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
  runForm: {
    gap: spacing.xs,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
    paddingTop: spacing.sm,
  },
  runLabel: {
    marginTop: spacing.xs,
  },
  runInput: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radii.sm,
    paddingHorizontal: spacing.sm + 4,
    paddingVertical: spacing.sm,
    color: colors.textPrimary,
    fontSize: 15,
    backgroundColor: colors.surfaceSunk,
  },
  runButtons: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    alignItems: 'center',
    gap: spacing.sm,
    marginTop: spacing.xs,
  },
  runKindRow: {
    flexDirection: 'row',
    gap: spacing.sm,
    marginTop: spacing.xs,
  },
  runRecordedRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
    paddingTop: spacing.sm,
  },
  runRecordedText: {
    flex: 1,
  },
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
  jobLink: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 2,
    borderRadius: radii.pill,
    paddingLeft: spacing.sm + 2,
    paddingRight: spacing.xs + 2,
    paddingVertical: spacing.xs,
    flexShrink: 1,
  },
  jobLinkText: {
    flexShrink: 1,
  },
  pagerChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs + 2,
    borderRadius: radii.pill,
    paddingHorizontal: spacing.sm + 4,
    paddingVertical: spacing.xs + 2,
  },
  pagerChipDisabled: {
    opacity: 0.45,
  },
  logRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
  },
  logMessage: {
    flex: 1,
  },
  jobNumber: {
    fontVariant: ['tabular-nums'],
  },
  jobListHint: {
    marginTop: spacing.xs,
  },
});
