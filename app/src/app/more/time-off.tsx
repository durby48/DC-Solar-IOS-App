import Ionicons from '@expo/vector-icons/Ionicons';
import DateTimePicker from '@react-native-community/datetimepicker';
import { Stack } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';

import { colors, radii, shadows, spacing } from '@/constants/theme';
import { formatShortDate, parseISODate, todayISO } from '@/lib/dates';
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

const STATUS_STYLES: Record<TimeOffStatus, { bg: string; text: string; label: string }> = {
  pending: { bg: colors.tan, text: colors.inkSoft, label: 'Pending' },
  approved: { bg: colors.skySoft, text: colors.ocean, label: 'Approved' },
  denied: { bg: colors.cream, text: colors.danger, label: 'Denied' },
};

function formatRange(start: string, end: string): string {
  if (start === end) return formatShortDate(start);
  return `${formatShortDate(start)} – ${formatShortDate(end)}`;
}

function StatusPill({ status }: { status: TimeOffStatus }) {
  const style = STATUS_STYLES[status];
  return (
    <View style={[styles.pill, { backgroundColor: style.bg }]}>
      <Text style={[styles.pillText, { color: style.text }]}>{style.label}</Text>
    </View>
  );
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
      <ScrollView
        style={styles.screen}
        contentContainerStyle={styles.content}
        keyboardShouldPersistTaps="handled">
        {signedIn === null ? (
          <View style={styles.placeholderCard}>
            <ActivityIndicator color={colors.ocean} />
          </View>
        ) : !signedIn ? (
          <View style={styles.placeholderCard}>
            <Ionicons name="lock-closed" size={22} color={colors.inkSoft} />
            <Text style={styles.placeholderText}>Sign in to request time off.</Text>
          </View>
        ) : (
          <>
            {role?.isAdmin ? (
              <>
                <Text style={styles.sectionTitle}>Pending requests</Text>
                {pendingState === 'loading' ? (
                  <View style={styles.placeholderCard}>
                    <ActivityIndicator color={colors.ocean} />
                  </View>
                ) : pendingState === 'unavailable' ? (
                  <View style={styles.placeholderCard}>
                    <Ionicons name="cloud-offline" size={22} color={colors.inkSoft} />
                    <Text style={styles.placeholderText}>Requests not available right now</Text>
                  </View>
                ) : pending.length === 0 ? (
                  <View style={styles.placeholderCard}>
                    <Ionicons name="checkmark-done" size={22} color={colors.inkSoft} />
                    <Text style={styles.placeholderText}>No pending requests</Text>
                  </View>
                ) : (
                  <View style={styles.card}>
                    {pending.map((request, index) => (
                      <View
                        key={request.id}
                        style={[styles.row, index > 0 && styles.rowBorderTop]}>
                        <View style={styles.rowBody}>
                          <Text style={styles.rowValue}>{requesterLabel(request)}</Text>
                          <Text style={styles.rowMeta}>
                            {formatRange(request.start_date, request.end_date)} ·{' '}
                            {TIME_OFF_KIND_LABELS[request.kind] ?? request.kind}
                          </Text>
                          {request.reason ? (
                            <Text style={styles.rowNote}>{request.reason}</Text>
                          ) : null}
                        </View>
                        <View style={styles.reviewButtons}>
                          <Pressable
                            onPress={() => review(request, 'approved')}
                            disabled={reviewingId != null}
                            style={({ pressed }) => [
                              styles.approveButton,
                              (pressed || reviewingId === request.id) && styles.pressed,
                            ]}>
                            <Text style={styles.approveButtonText}>Approve</Text>
                          </Pressable>
                          <Pressable
                            onPress={() => review(request, 'denied')}
                            disabled={reviewingId != null}
                            style={({ pressed }) => [
                              styles.denyButton,
                              (pressed || reviewingId === request.id) && styles.pressed,
                            ]}>
                            <Text style={styles.denyButtonText}>Deny</Text>
                          </Pressable>
                        </View>
                      </View>
                    ))}
                  </View>
                )}
              </>
            ) : null}

            <Text style={styles.sectionTitle}>Request time off</Text>
            {!showForm ? (
              <Pressable
                onPress={() => setShowForm(true)}
                style={({ pressed }) => [styles.requestButton, pressed && styles.pressed]}>
                <Ionicons name="sunny" size={18} color={colors.ink} />
                <Text style={styles.requestButtonText}>Request time off</Text>
              </Pressable>
            ) : (
              <View style={styles.formCard}>
                <View style={styles.kindSelector}>
                  {KINDS.map((k) => (
                    <Pressable
                      key={k}
                      onPress={() => setKind(k)}
                      style={[styles.kindChip, kind === k && styles.kindChipSelected]}>
                      <Text
                        style={[styles.kindChipText, kind === k && styles.kindChipTextSelected]}>
                        {TIME_OFF_KIND_LABELS[k]}
                      </Text>
                    </Pressable>
                  ))}
                </View>

                {Platform.OS === 'web' ? (
                  <>
                    <View style={styles.fieldRow}>
                      <Text style={styles.fieldLabel}>Start date</Text>
                      <TextInput
                        value={startText}
                        onChangeText={setStartText}
                        placeholder="YYYY-MM-DD"
                        placeholderTextColor={colors.inkSoft}
                        style={styles.input}
                        autoCapitalize="none"
                      />
                    </View>
                    <View style={styles.fieldRow}>
                      <Text style={styles.fieldLabel}>End date</Text>
                      <TextInput
                        value={endText}
                        onChangeText={setEndText}
                        placeholder="YYYY-MM-DD (blank = 1 day)"
                        placeholderTextColor={colors.inkSoft}
                        style={styles.input}
                        autoCapitalize="none"
                      />
                    </View>
                  </>
                ) : (
                  <>
                    <Pressable
                      onPress={() => setPickerMode(pickerMode === 'start' ? null : 'start')}
                      style={({ pressed }) => [styles.fieldRow, pressed && styles.pressed]}>
                      <Text style={styles.fieldLabel}>Start date</Text>
                      <Text style={styles.fieldValue}>
                        {draftStart ? formatShortDate(toISODate(draftStart)) : 'Pick a date'}
                      </Text>
                    </Pressable>
                    <Pressable
                      onPress={() => setPickerMode(pickerMode === 'end' ? null : 'end')}
                      style={({ pressed }) => [styles.fieldRow, pressed && styles.pressed]}>
                      <Text style={styles.fieldLabel}>End date</Text>
                      <Text style={styles.fieldValue}>
                        {draftEnd ? formatShortDate(toISODate(draftEnd)) : 'Same as start'}
                      </Text>
                    </Pressable>
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
                  <Text style={styles.fieldLabel}>Reason</Text>
                  <TextInput
                    value={reason}
                    onChangeText={setReason}
                    placeholder="Optional"
                    placeholderTextColor={colors.inkSoft}
                    style={styles.input}
                  />
                </View>

                <View style={styles.formButtons}>
                  <Pressable
                    onPress={resetForm}
                    disabled={saving}
                    style={({ pressed }) => [styles.cancelButton, pressed && styles.pressed]}>
                    <Text style={styles.cancelButtonText}>Cancel</Text>
                  </Pressable>
                  <Pressable
                    onPress={Platform.OS === 'web' ? submitWeb : submitNative}
                    disabled={saving}
                    style={({ pressed }) => [
                      styles.saveButton,
                      (pressed || saving) && styles.pressed,
                    ]}>
                    {saving ? (
                      <ActivityIndicator color={colors.ink} size="small" />
                    ) : (
                      <Text style={styles.saveButtonText}>Submit request</Text>
                    )}
                  </Pressable>
                </View>
              </View>
            )}
            {error ? <Text style={styles.errorText}>{error}</Text> : null}

            <Text style={styles.sectionTitle}>My requests</Text>
            {myState === 'loading' ? (
              <View style={styles.placeholderCard}>
                <ActivityIndicator color={colors.ocean} />
              </View>
            ) : myState === 'unavailable' ? (
              <View style={styles.placeholderCard}>
                <Ionicons name="cloud-offline" size={22} color={colors.inkSoft} />
                <Text style={styles.placeholderText}>Requests not available right now</Text>
              </View>
            ) : myRequests.length === 0 ? (
              <View style={styles.placeholderCard}>
                <Ionicons name="cafe" size={22} color={colors.inkSoft} />
                <Text style={styles.placeholderText}>No requests yet</Text>
              </View>
            ) : (
              <View style={styles.card}>
                {myRequests.map((request, index) => (
                  <View key={request.id} style={[styles.row, index > 0 && styles.rowBorderTop]}>
                    <View style={styles.iconWrap}>
                      <Ionicons name="sunny" size={18} color={colors.ocean} />
                    </View>
                    <View style={styles.rowBody}>
                      <Text style={styles.rowValue}>
                        {formatRange(request.start_date, request.end_date)}
                      </Text>
                      <Text style={styles.rowMeta}>
                        {TIME_OFF_KIND_LABELS[request.kind] ?? request.kind}
                        {request.reason ? ` · ${request.reason}` : ''}
                      </Text>
                    </View>
                    <StatusPill status={request.status} />
                  </View>
                ))}
              </View>
            )}
          </>
        )}
      </ScrollView>
    </>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: colors.cream,
  },
  content: {
    padding: spacing.md,
    paddingBottom: spacing.xxl,
    gap: spacing.md,
  },
  sectionTitle: {
    color: colors.ink,
    fontSize: 18,
    fontWeight: '700',
    marginTop: spacing.sm,
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
  card: {
    backgroundColor: colors.white,
    borderRadius: radii.md,
    overflow: 'hidden',
    ...shadows.card,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    padding: spacing.md,
  },
  rowBorderTop: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.tan,
  },
  iconWrap: {
    width: 32,
    height: 32,
    borderRadius: radii.sm,
    backgroundColor: colors.skySoft,
    alignItems: 'center',
    justifyContent: 'center',
  },
  rowBody: {
    flex: 1,
    gap: 2,
  },
  rowValue: {
    color: colors.ink,
    fontSize: 15,
    fontWeight: '600',
  },
  rowMeta: {
    color: colors.inkSoft,
    fontSize: 12,
    fontWeight: '600',
  },
  rowNote: {
    color: colors.inkSoft,
    fontSize: 12,
    fontStyle: 'italic',
  },
  pill: {
    borderRadius: radii.pill,
    paddingHorizontal: spacing.sm + 2,
    paddingVertical: spacing.xs,
  },
  pillText: {
    fontSize: 11,
    fontWeight: '800',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  reviewButtons: {
    gap: spacing.xs,
    alignItems: 'stretch',
  },
  approveButton: {
    backgroundColor: colors.sun,
    borderRadius: radii.pill,
    paddingVertical: spacing.xs + 2,
    paddingHorizontal: spacing.md,
    alignItems: 'center',
  },
  approveButtonText: {
    color: colors.ink,
    fontSize: 13,
    fontWeight: '800',
  },
  denyButton: {
    backgroundColor: colors.cream,
    borderRadius: radii.pill,
    borderWidth: 1,
    borderColor: colors.danger,
    paddingVertical: spacing.xs + 1,
    paddingHorizontal: spacing.md,
    alignItems: 'center',
  },
  denyButtonText: {
    color: colors.danger,
    fontSize: 13,
    fontWeight: '800',
  },
  requestButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.sm,
    backgroundColor: colors.sun,
    borderRadius: radii.pill,
    paddingVertical: spacing.md - 2,
    paddingHorizontal: spacing.lg,
    ...shadows.card,
  },
  requestButtonText: {
    color: colors.ink,
    fontSize: 15,
    fontWeight: '800',
  },
  formCard: {
    backgroundColor: colors.white,
    borderRadius: radii.md,
    padding: spacing.md,
    gap: spacing.sm,
    ...shadows.card,
  },
  kindSelector: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.sm,
  },
  kindChip: {
    backgroundColor: colors.white,
    borderRadius: radii.pill,
    borderWidth: 1,
    borderColor: colors.tan,
    paddingHorizontal: spacing.sm + 2,
    paddingVertical: spacing.xs,
  },
  kindChipSelected: {
    backgroundColor: colors.sunLight,
    borderColor: colors.sun,
  },
  kindChipText: {
    color: colors.inkSoft,
    fontSize: 12,
    fontWeight: '700',
  },
  kindChipTextSelected: {
    color: colors.ink,
  },
  fieldRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.md,
    paddingVertical: spacing.xs,
  },
  fieldLabel: {
    color: colors.inkSoft,
    fontSize: 12,
    fontWeight: '700',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  fieldValue: {
    color: colors.ocean,
    fontSize: 15,
    fontWeight: '700',
  },
  input: {
    flex: 1,
    maxWidth: 220,
    borderWidth: 1,
    borderColor: colors.tan,
    borderRadius: radii.sm,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs + 2,
    color: colors.ink,
    fontSize: 14,
    fontWeight: '600',
    backgroundColor: colors.cream,
  },
  formButtons: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    gap: spacing.sm,
    marginTop: spacing.xs,
  },
  cancelButton: {
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.md,
    borderRadius: radii.pill,
  },
  cancelButtonText: {
    color: colors.inkSoft,
    fontSize: 14,
    fontWeight: '700',
  },
  saveButton: {
    backgroundColor: colors.sun,
    borderRadius: radii.pill,
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.lg,
    alignItems: 'center',
    justifyContent: 'center',
  },
  saveButtonText: {
    color: colors.ink,
    fontSize: 14,
    fontWeight: '800',
  },
  pressed: {
    opacity: 0.7,
  },
  errorText: {
    color: colors.danger,
    fontSize: 13,
    fontWeight: '600',
    textAlign: 'center',
  },
});
