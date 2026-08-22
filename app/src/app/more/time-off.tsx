import DateTimePicker from '@react-native-community/datetimepicker';
import Ionicons from '@expo/vector-icons/Ionicons';
import { Stack } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { Platform, StyleSheet, TextInput, View } from 'react-native';

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
  SectionHeader,
  SkeletonList,
} from '@/components/ui';
import { colors, radii, spacing } from '@/constants/theme';
import { formatShortDate, parseISODate, todayISO } from '@/lib/dates';
import { haptics } from '@/lib/haptics';
import { useRole } from '@/lib/role';
import { supabase } from '@/lib/supabase';
import { isValidISODate, toISODate } from '@/lib/time';
import {
  fetchEmployeeNames,
  fetchMyTimeOff,
  fetchPendingTimeOff,
  reviewTimeOff,
  submitTimeOff,
  TIME_OFF_KIND_LABELS,
  type TimeOffKind,
  type TimeOffRequest,
  type TimeOffStatus,
} from '@/lib/timeoff';

const KINDS = Object.keys(TIME_OFF_KIND_LABELS) as TimeOffKind[];

/**
 * Request status colors — this screen's own vocabulary, now drawn by `<Pill>`
 * rather than a local `styles.pill`. Waiting is amber, approved is mint,
 * denied is coral: the same three-way reading as before on the 2026-08 ramp.
 */
const STATUS_STYLES: Record<TimeOffStatus, { bg: string; fg: string; label: string }> = {
  pending: { bg: colors.amberSoft, fg: colors.amberDeep, label: 'Pending' },
  approved: { bg: colors.mintSoft, fg: colors.mintDeep, label: 'Approved' },
  denied: { bg: colors.coralSoft, fg: colors.coralDeep, label: 'Denied' },
};

function formatRange(start: string, end: string): string {
  if (start === end) return formatShortDate(start);
  return `${formatShortDate(start)} – ${formatShortDate(end)}`;
}

function StatusPill({ status }: { status: TimeOffStatus }) {
  const style = STATUS_STYLES[status];
  return <Pill label={style.label} bg={style.bg} fg={style.fg} />;
}

export default function TimeOffScreen() {
  const role = useRole();
  const [signedIn, setSignedIn] = useState<boolean | null>(null);
  const [email, setEmail] = useState<string | null>(null);

  // My requests
  const [myState, setMyState] = useState<'loading' | 'ok' | 'unavailable'>('loading');
  const [myRequests, setMyRequests] = useState<TimeOffRequest[]>([]);

  // Admin pending queue
  const [pending, setPending] = useState<TimeOffRequest[]>([]);
  const [pendingState, setPendingState] = useState<'loading' | 'ok' | 'unavailable'>('loading');
  const [names, setNames] = useState<Record<string, string>>({});
  const [reviewingId, setReviewingId] = useState<string | null>(null);

  // Request form
  const [showForm, setShowForm] = useState(false);
  const [saving, setSaving] = useState(false);
  const [kind, setKind] = useState<TimeOffKind>('unpaid');
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  // Native picker state
  const [draftStart, setDraftStart] = useState<Date | null>(null);
  const [draftEnd, setDraftEnd] = useState<Date | null>(null);
  const [pickerMode, setPickerMode] = useState<'start' | 'end' | null>(null);
  // Web text-input state
  const [startText, setStartText] = useState('');
  const [endText, setEndText] = useState('');

  useEffect(() => {
    let cancelled = false;
    supabase.auth.getSession().then(({ data }) => {
      if (cancelled) return;
      setSignedIn(data.session != null);
      setEmail(data.session?.user?.email ?? null);
    });
    const { data: sub } = supabase.auth.onAuthStateChange((_event, session) => {
      if (cancelled) return;
      setSignedIn(session != null);
      setEmail(session?.user?.email ?? null);
    });
    return () => {
      cancelled = true;
      sub.subscription.unsubscribe();
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    if (!email) {
      setMyRequests([]);
      setMyState(signedIn === null ? 'loading' : 'ok');
      return;
    }
    setMyState('loading');
    fetchMyTimeOff(email).then((result) => {
      if (cancelled) return;
      if (result.status === 'ok') {
        setMyRequests(result.requests);
        setMyState('ok');
      } else {
        setMyRequests([]);
        setMyState('unavailable');
      }
    });
    return () => {
      cancelled = true;
    };
  }, [email, signedIn]);

  const loadPending = useCallback(async () => {
    const [result, nameMap] = await Promise.all([fetchPendingTimeOff(), fetchEmployeeNames()]);
    setNames(nameMap);
    if (result.status === 'ok') {
      setPending(result.requests);
      setPendingState('ok');
    } else {
      setPending([]);
      setPendingState('unavailable');
    }
  }, []);

  useEffect(() => {
    if (role?.isAdmin) loadPending();
  }, [role?.isAdmin, loadPending]);

  const resetForm = () => {
    setShowForm(false);
    setSaving(false);
    setKind('unpaid');
    setReason('');
    setError(null);
    setDraftStart(null);
    setDraftEnd(null);
    setPickerMode(null);
    setStartText('');
    setEndText('');
  };

  const saveRequest = async (startDate: string, endDate: string) => {
    if (!email) return;
    if (endDate < startDate) {
      setError('End date must be on or after the start date.');
      return;
    }
    setSaving(true);
    setError(null);
    const result = await submitTimeOff({
      employee: email,
      startDate,
      endDate,
      kind,
      reason: reason.trim() || null,
    });
    if (result.ok) {
      setMyRequests((prev) => [result.request, ...prev]);
      setMyState('ok');
      haptics.success();
      resetForm();
    } else {
      setSaving(false);
      setError(result.message);
    }
  };

  const submitNative = () => {
    if (!draftStart) {
      setError('Pick a start date first.');
      return;
    }
    const start = toISODate(draftStart);
    const end = draftEnd ? toISODate(draftEnd) : start;
    saveRequest(start, end);
  };

  const submitWeb = () => {
    const start = startText.trim();
    const end = endText.trim() || start;
    if (!isValidISODate(start)) {
      setError('Enter the start date as YYYY-MM-DD.');
      return;
    }
    if (!isValidISODate(end)) {
      setError('Enter the end date as YYYY-MM-DD, or leave it blank for one day.');
      return;
    }
    saveRequest(start, end);
  };

  const review = async (request: TimeOffRequest, status: 'approved' | 'denied') => {
    if (!role?.email || reviewingId) return;
    setReviewingId(request.id);
    const result = await reviewTimeOff({ id: request.id, status, reviewerEmail: role.email });
    setReviewingId(null);
    if (result.ok) {
      if (status === 'approved') haptics.success();
      else haptics.warn();
      setPending((prev) => prev.filter((r) => r.id !== request.id));
      if (result.request.employee === email) {
        setMyRequests((prev) =>
          prev.map((r) => (r.id === result.request.id ? result.request : r)),
        );
      }
    }
  };

  const requesterLabel = (request: TimeOffRequest) => names[request.employee] ?? request.employee;

  return (
    <>
      <Stack.Screen options={{ title: 'Time off' }} />
      <Screen edges={[]}>
        {signedIn === null ? (
          <SkeletonList count={3} height={72} />
        ) : !signedIn ? (
          <Card>
            <EmptyState
              icon="lock-closed"
              title="Sign in to request time off."
              body="Requests are recorded against your account so the office knows who is out."
            />
          </Card>
        ) : (
          <>
            {role?.isAdmin ? (
              <View style={styles.section}>
                <SectionHeader title="Pending requests" icon="hourglass-outline" />
                {pendingState === 'loading' ? (
                  <SkeletonList count={2} height={84} />
                ) : pendingState === 'unavailable' ? (
                  <Card>
                    <EmptyState
                      icon="cloud-offline"
                      title="Requests not available right now"
                      body="The queue could not be loaded. Try again once you are back on a signal."
                    />
                  </Card>
                ) : pending.length === 0 ? (
                  <Card>
                    <EmptyState
                      icon="checkmark-done"
                      title="No pending requests"
                      body="Anything the crew asks for lands here for approval."
                    />
                  </Card>
                ) : (
                  <Card padded={false}>
                    {pending.map((request, index) => (
                      <FadeInUp key={request.id} index={index}>
                        <View style={[styles.row, index > 0 && styles.rowBorderTop]}>
                          <View style={styles.rowBody}>
                            <AppText variant="bodyStrong">{requesterLabel(request)}</AppText>
                            <AppText variant="caption" color={colors.textMuted}>
                              {formatRange(request.start_date, request.end_date)} ·{' '}
                              {TIME_OFF_KIND_LABELS[request.kind] ?? request.kind}
                            </AppText>
                            {request.reason ? (
                              <AppText
                                variant="caption"
                                color={colors.textSecondary}
                                style={styles.rowNote}>
                                {request.reason}
                              </AppText>
                            ) : null}
                          </View>
                          <View style={styles.reviewButtons}>
                            <Button
                              label="Approve"
                              size="sm"
                              disabled={reviewingId != null && reviewingId !== request.id}
                              loading={reviewingId === request.id}
                              onPress={() => review(request, 'approved')}
                            />
                            <Button
                              label="Deny"
                              variant="danger"
                              size="sm"
                              disabled={reviewingId != null}
                              onPress={() => review(request, 'denied')}
                            />
                          </View>
                        </View>
                      </FadeInUp>
                    ))}
                  </Card>
                )}
              </View>
            ) : null}

            <View style={styles.section}>
              <SectionHeader title="Request time off" icon="sunny-outline" />
              {!showForm ? (
                <Button
                  label="Request time off"
                  icon="sunny"
                  size="lg"
                  fullWidth
                  onPress={() => setShowForm(true)}
                />
              ) : (
                <Card style={styles.formCard}>
                  <View style={styles.kindSelector}>
                    {KINDS.map((k) => (
                      <Chip
                        key={k}
                        label={TIME_OFF_KIND_LABELS[k]}
                        tone="sun"
                        selected={kind === k}
                        onPress={() => setKind(k)}
                      />
                    ))}
                  </View>

                  {Platform.OS === 'web' ? (
                    <>
                      <View style={styles.fieldRow}>
                        <AppText variant="section" color={colors.textMuted}>
                          Start date
                        </AppText>
                        <TextInput
                          value={startText}
                          onChangeText={setStartText}
                          placeholder="YYYY-MM-DD"
                          placeholderTextColor={colors.textMuted}
                          style={styles.input}
                          autoCapitalize="none"
                        />
                      </View>
                      <View style={styles.fieldRow}>
                        <AppText variant="section" color={colors.textMuted}>
                          End date
                        </AppText>
                        <TextInput
                          value={endText}
                          onChangeText={setEndText}
                          placeholder="YYYY-MM-DD (blank = 1 day)"
                          placeholderTextColor={colors.textMuted}
                          style={styles.input}
                          autoCapitalize="none"
                        />
                      </View>
                    </>
                  ) : (
                    <>
                      <AnimatedPressable
                        onPress={() => setPickerMode(pickerMode === 'start' ? null : 'start')}
                        haptic="tapLight"
                        scaleTo={0.99}
                        accessibilityRole="button"
                        accessibilityLabel="Pick the start date"
                        style={styles.fieldRow}>
                        <AppText variant="section" color={colors.textMuted}>
                          Start date
                        </AppText>
                        <AppText variant="bodyStrong" color={colors.accentPrimary}>
                          {draftStart ? formatShortDate(toISODate(draftStart)) : 'Pick a date'}
                        </AppText>
                      </AnimatedPressable>
                      <AnimatedPressable
                        onPress={() => setPickerMode(pickerMode === 'end' ? null : 'end')}
                        haptic="tapLight"
                        scaleTo={0.99}
                        accessibilityRole="button"
                        accessibilityLabel="Pick the end date"
                        style={styles.fieldRow}>
                        <AppText variant="section" color={colors.textMuted}>
                          End date
                        </AppText>
                        <AppText variant="bodyStrong" color={colors.accentPrimary}>
                          {draftEnd ? formatShortDate(toISODate(draftEnd)) : 'Same as start'}
                        </AppText>
                      </AnimatedPressable>
                      {pickerMode ? (
                        <DateTimePicker
                          value={
                            pickerMode === 'start'
                              ? (draftStart ?? parseISODate(todayISO()))
                              : (draftEnd ?? draftStart ?? parseISODate(todayISO()))
                          }
                          mode="date"
                          display={Platform.OS === 'ios' ? 'spinner' : 'default'}
                          themeVariant="light"
                          onChange={(event, selected) => {
                            if (Platform.OS !== 'ios') setPickerMode(null);
                            if (event.type === 'set' && selected) {
                              if (pickerMode === 'start') setDraftStart(selected);
                              else setDraftEnd(selected);
                            }
                          }}
                        />
                      ) : null}
                    </>
                  )}

                  <View style={styles.fieldRow}>
                    <AppText variant="section" color={colors.textMuted}>
                      Reason
                    </AppText>
                    <TextInput
                      value={reason}
                      onChangeText={setReason}
                      placeholder="Optional"
                      placeholderTextColor={colors.textMuted}
                      style={styles.input}
                    />
                  </View>

                  <View style={styles.formButtons}>
                    <Button
                      label="Cancel"
                      variant="ghost"
                      size="sm"
                      disabled={saving}
                      onPress={resetForm}
                    />
                    <Button
                      label="Submit request"
                      size="sm"
                      loading={saving}
                      onPress={Platform.OS === 'web' ? submitWeb : submitNative}
                    />
                  </View>
                </Card>
              )}
              {error ? (
                <AppText variant="caption" color={colors.danger} align="center">
                  {error}
                </AppText>
              ) : null}
            </View>

            <View style={styles.section}>
              <SectionHeader title="My requests" icon="calendar-outline" />
              {myState === 'loading' ? (
                <SkeletonList count={3} height={64} />
              ) : myState === 'unavailable' ? (
                <Card>
                  <EmptyState
                    icon="cloud-offline"
                    title="Requests not available right now"
                    body="Your list could not be loaded. Try again once you are back on a signal."
                  />
                </Card>
              ) : myRequests.length === 0 ? (
                <Card>
                  <EmptyState
                    icon="cafe"
                    title="No requests yet"
                    body="Ask for a day off above and it shows up here with its status."
                  />
                </Card>
              ) : (
                <Card padded={false}>
                  {myRequests.map((request, index) => (
                    <FadeInUp key={request.id} index={index}>
                      <View style={[styles.row, index > 0 && styles.rowBorderTop]}>
                        <View style={styles.iconWrap}>
                          <Ionicons name="sunny" size={18} color={colors.accentPrimary} />
                        </View>
                        <View style={styles.rowBody}>
                          <AppText variant="bodyStrong">
                            {formatRange(request.start_date, request.end_date)}
                          </AppText>
                          <AppText variant="caption" color={colors.textMuted}>
                            {TIME_OFF_KIND_LABELS[request.kind] ?? request.kind}
                            {request.reason ? ` · ${request.reason}` : ''}
                          </AppText>
                        </View>
                        <StatusPill status={request.status} />
                      </View>
                    </FadeInUp>
                  ))}
                </Card>
              )}
            </View>
          </>
        )}
      </Screen>
    </>
  );
}

const styles = StyleSheet.create({
  section: {
    marginTop: spacing.sm,
    gap: spacing.sm,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    padding: spacing.md,
    backgroundColor: colors.surface,
  },
  rowBorderTop: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
  },
  iconWrap: {
    width: 32,
    height: 32,
    borderRadius: radii.sm,
    backgroundColor: colors.oliveSoft,
    alignItems: 'center',
    justifyContent: 'center',
  },
  rowBody: {
    flex: 1,
    gap: 2,
  },
  rowNote: {
    fontStyle: 'italic',
  },
  reviewButtons: {
    gap: spacing.xs,
    alignItems: 'stretch',
  },
  formCard: {
    gap: spacing.sm,
  },
  kindSelector: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.sm,
  },
  fieldRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.md,
    paddingVertical: spacing.xs,
  },
  input: {
    flex: 1,
    maxWidth: 220,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radii.sm,
    paddingHorizontal: spacing.sm + 4,
    paddingVertical: spacing.xs + 4,
    color: colors.textPrimary,
    fontSize: 14,
    backgroundColor: colors.surfaceSunk,
  },
  formButtons: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'flex-end',
    gap: spacing.sm,
    marginTop: spacing.xs,
  },
});
