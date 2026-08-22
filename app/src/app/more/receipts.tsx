import Ionicons from '@expo/vector-icons/Ionicons';
import { Image } from 'expo-image';
import * as ImagePicker from 'expo-image-picker';
import { Stack } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Platform,
  StyleSheet,
  Switch,
  TextInput,
  View,
} from 'react-native';

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
import { formatShortDate } from '@/lib/dates';
import { haptics } from '@/lib/haptics';
import {
  approveReceipt,
  fetchActiveJobs,
  fetchMyReceipts,
  fetchPendingReceipts,
  getReceiptPhotoUrl,
  RECEIPT_CATEGORIES,
  rejectReceipt,
  submitReceipt,
  uploadReceiptPhoto,
  type JobOption,
  type Receipt,
  type ReceiptCategory,
  type ReceiptStatus,
} from '@/lib/receipts';
import { useRole } from '@/lib/role';
import { supabase } from '@/lib/supabase';

/**
 * Receipt status colors. The map still lives here — it is this screen's
 * vocabulary — but it now feeds `<Pill>` from the UI kit instead of a local
 * `styles.pill`, and it speaks the accent ramp: amber for waiting, mint for
 * accepted, coral for refused. That is the same three-way reading the crew
 * already had (sun / sky / danger), tuned to the 2026-08 palette.
 */
const STATUS_PILLS: Record<ReceiptStatus, { bg: string; fg: string; label: string }> = {
  pending: { bg: colors.amberSoft, fg: colors.amberDeep, label: 'Pending' },
  approved: { bg: colors.mintSoft, fg: colors.mintDeep, label: 'Approved' },
  rejected: { bg: colors.coralSoft, fg: colors.coralDeep, label: 'Rejected' },
};

function formatMoney(amount: number): string {
  return `$${amount.toFixed(2)}`;
}

/** Session email + loading state (role.ts returns null both while loading and signed out). */
function useAuthEmail(): { state: 'loading' | 'out' | 'in'; email: string | null } {
  const [email, setEmail] = useState<string | null>(null);
  const [state, setState] = useState<'loading' | 'out' | 'in'>('loading');
  useEffect(() => {
    let cancelled = false;
    supabase.auth.getSession().then(({ data }) => {
      if (cancelled) return;
      const e = data.session?.user?.email ?? null;
      setEmail(e);
      setState(e ? 'in' : 'out');
    });
    const { data: sub } = supabase.auth.onAuthStateChange((_event, session) => {
      if (cancelled) return;
      const e = session?.user?.email ?? null;
      setEmail(e);
      setState(e ? 'in' : 'out');
    });
    return () => {
      cancelled = true;
      sub.subscription.unsubscribe();
    };
  }, []);
  return { state, email };
}

function notify(
  setStatus: (s: { kind: 'success' | 'error'; message: string } | null) => void,
  kind: 'success' | 'error',
  title: string,
  message: string,
) {
  if (Platform.OS === 'web') {
    setStatus({ kind, message: `${title}: ${message}` });
  } else {
    setStatus(null);
    Alert.alert(title, message);
  }
}

export default function ReceiptsScreen() {
  const auth = useAuthEmail();
  const role = useRole();
  const isAdmin = role?.isAdmin ?? false;

  const [jobs, setJobs] = useState<JobOption[]>([]);

  // Submit form state
  const [photo, setPhoto] = useState<ImagePicker.ImagePickerAsset | null>(null);
  const [amountText, setAmountText] = useState('');
  const [description, setDescription] = useState('');
  const [category, setCategory] = useState<ReceiptCategory>('materials');
  const [method, setMethod] = useState('');
  const [jobId, setJobId] = useState<string | null>(null);
  const [needsReimbursed, setNeedsReimbursed] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  // Lists
  const [mineState, setMineState] = useState<'loading' | 'ok' | 'unavailable'>('loading');
  const [mine, setMine] = useState<Receipt[]>([]);
  const [pendingState, setPendingState] = useState<'loading' | 'ok' | 'unavailable'>('loading');
  const [pending, setPending] = useState<Receipt[]>([]);
  const [thumbs, setThumbs] = useState<Record<string, string>>({});
  const [reviewBusy, setReviewBusy] = useState<Record<string, boolean>>({});

  const [status, setStatus] = useState<{ kind: 'success' | 'error'; message: string } | null>(
    null,
  );

  const loadMine = useCallback(async (email: string) => {
    const result = await fetchMyReceipts(email);
    if (result.status === 'ok') {
      setMine(result.receipts);
      setMineState('ok');
    } else {
      setMine([]);
      setMineState('unavailable');
    }
  }, []);

  const signThumbs = useCallback(async (receipts: Receipt[]) => {
    const withPhotos = receipts.filter((r) => r.storage_path);
    const pairs = await Promise.all(
      withPhotos.map(
        async (r) => [r.id, await getReceiptPhotoUrl(r.storage_path as string)] as const,
      ),
    );
    setThumbs((prev) => {
      const next = { ...prev };
      for (const [id, url] of pairs) {
        if (url) next[id] = url;
      }
      return next;
    });
  }, []);

  const loadPending = useCallback(async () => {
    const result = await fetchPendingReceipts();
    if (result.status === 'ok') {
      setPending(result.receipts);
      setPendingState('ok');
      signThumbs(result.receipts);
    } else {
      setPending([]);
      setPendingState('unavailable');
    }
  }, [signThumbs]);

  useEffect(() => {
    if (auth.state !== 'in' || !auth.email) return;
    loadMine(auth.email);
    fetchActiveJobs().then(setJobs);
  }, [auth.state, auth.email, loadMine]);

  useEffect(() => {
    if (auth.state === 'in' && isAdmin) loadPending();
  }, [auth.state, isAdmin, loadPending]);

  // -- Photo picking --------------------------------------------------------

  const takePhoto = async () => {
    setStatus(null);
    try {
      const perm = await ImagePicker.requestCameraPermissionsAsync();
      if (!perm.granted) {
        notify(setStatus, 'error', 'Camera unavailable', 'Camera permission was not granted.');
        return;
      }
      const result = await ImagePicker.launchCameraAsync({ quality: 0.7 });
      if (!result.canceled && result.assets?.length) setPhoto(result.assets[0]);
    } catch {
      notify(setStatus, 'error', 'Camera failed', 'Something went wrong. Please try again.');
    }
  };

  const pickFromLibrary = async () => {
    setStatus(null);
    try {
      const result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ['images'],
        quality: 0.7,
      });
      if (!result.canceled && result.assets?.length) setPhoto(result.assets[0]);
    } catch {
      notify(setStatus, 'error', 'Picker failed', 'Something went wrong. Please try again.');
    }
  };

  const choosePhotoSource = () => {
    Alert.alert('Receipt photo', undefined, [
      { text: 'Take photo', onPress: () => void takePhoto() },
      { text: 'Choose from library', onPress: () => void pickFromLibrary() },
      { text: 'Cancel', style: 'cancel' },
    ]);
  };

  // -- Submit ---------------------------------------------------------------

  const resetForm = () => {
    setPhoto(null);
    setAmountText('');
    setDescription('');
    setCategory('materials');
    setMethod('');
    setJobId(null);
    setNeedsReimbursed(false);
  };

  const submit = async () => {
    if (!auth.email) return;
    setStatus(null);
    const amount = Number(amountText.replace(/[^0-9.]/g, ''));
    if (!Number.isFinite(amount) || amount <= 0) {
      notify(setStatus, 'error', 'Missing amount', 'Enter the receipt total, e.g. 42.50.');
      return;
    }
    if (!description.trim()) {
      notify(setStatus, 'error', 'Missing description', 'Add a short description of the purchase.');
      return;
    }
    setSubmitting(true);
    let storagePath: string | null = null;
    if (photo) {
      const upload = await uploadReceiptPhoto({
        email: auth.email,
        uri: photo.uri,
        fileName: photo.fileName ?? null,
        contentType: photo.mimeType ?? 'image/jpeg',
      });
      if (!upload.ok) {
        setSubmitting(false);
        notify(setStatus, 'error', 'Photo upload failed', upload.message);
        return;
      }
      storagePath = upload.storagePath;
    }
    const result = await submitReceipt({
      employee: auth.email,
      amount,
      description: description.trim(),
      category,
      method: method.trim() || null,
      jobId,
      needsReimbursed,
      storagePath,
    });
    setSubmitting(false);
    if (result.ok) {
      setMine((prev) => [result.receipt, ...prev]);
      setMineState('ok');
      resetForm();
      haptics.success();
      notify(setStatus, 'success', 'Receipt submitted', 'It is now waiting for review.');
    } else {
      notify(setStatus, 'error', 'Could not submit', result.message);
    }
  };

  // -- Admin review ---------------------------------------------------------

  const finishReview = (receipt: Receipt) => {
    setPending((prev) => prev.filter((r) => r.id !== receipt.id));
    setMine((prev) => prev.map((r) => (r.id === receipt.id ? receipt : r)));
  };

  const approve = async (receipt: Receipt) => {
    if (!auth.email) return;
    setStatus(null);
    setReviewBusy((prev) => ({ ...prev, [receipt.id]: true }));
    const result = await approveReceipt(receipt, auth.email);
    setReviewBusy((prev) => ({ ...prev, [receipt.id]: false }));
    if (result.ok) {
      finishReview(result.receipt);
      haptics.success();
      notify(setStatus, 'success', 'Approved', 'Expense recorded in the finance log.');
    } else {
      notify(setStatus, 'error', 'Approval problem', result.message);
    }
  };

  const reject = async (receipt: Receipt) => {
    if (!auth.email) return;
    setStatus(null);
    setReviewBusy((prev) => ({ ...prev, [receipt.id]: true }));
    const result = await rejectReceipt(receipt.id, auth.email);
    setReviewBusy((prev) => ({ ...prev, [receipt.id]: false }));
    if (result.ok) {
      finishReview(result.receipt);
      // Rejecting worked, but it is not good news — `warn` is the honest tick.
      haptics.warn();
      notify(setStatus, 'success', 'Rejected', 'The receipt was rejected.');
    } else {
      notify(setStatus, 'error', 'Could not reject', result.message);
    }
  };

  // -- Render helpers -------------------------------------------------------

  const jobLabel = (id: string | null): string | null => {
    if (!id) return null;
    const job = jobs.find((j) => j.id === id);
    if (!job) return null;
    return job.job_number ? `Job ${job.job_number}` : job.name;
  };

  const categoryLabel = (value: ReceiptCategory): string =>
    RECEIPT_CATEGORIES.find((c) => c.value === value)?.label ?? value;

  const renderStatusPill = (s: ReceiptStatus) => {
    const pill = STATUS_PILLS[s];
    return <Pill label={pill.label} bg={pill.bg} fg={pill.fg} />;
  };

  return (
    <>
      <Stack.Screen options={{ title: 'Receipts' }} />
      <Screen edges={[]}>
        {auth.state === 'loading' ? (
          <SkeletonList count={3} height={96} />
        ) : auth.state === 'out' ? (
          <Card>
            <EmptyState
              icon="receipt"
              title="Sign in to submit receipts"
              body="Receipts are tied to your account so the office can review and reimburse them."
            />
          </Card>
        ) : (
          <>
            {isAdmin ? (
              <View style={styles.section}>
                <SectionHeader title="Pending review" icon="hourglass-outline" />
                {pendingState === 'loading' ? (
                  <SkeletonList count={2} height={120} />
                ) : pendingState === 'unavailable' ? (
                  <Card>
                    <EmptyState
                      icon="cloud-offline-outline"
                      title="Pending receipts are unavailable right now."
                      body="The office list could not be loaded. Try again once you are back on a signal."
                    />
                  </Card>
                ) : pending.length === 0 ? (
                  <Card>
                    <EmptyState
                      icon="checkmark-circle"
                      title="No receipts waiting for review."
                      body="Anything the crew submits lands here."
                    />
                  </Card>
                ) : (
                  <View style={styles.stack}>
                    {pending.map((receipt, index) => (
                      <FadeInUp key={receipt.id} index={index}>
                        <Card style={styles.reviewCard}>
                          <View style={styles.reviewTop}>
                            {receipt.storage_path ? (
                              thumbs[receipt.id] ? (
                                <Image
                                  source={{ uri: thumbs[receipt.id] }}
                                  style={styles.reviewThumb}
                                  contentFit="cover"
                                  transition={150}
                                />
                              ) : (
                                <View style={[styles.reviewThumb, styles.reviewThumbEmpty]}>
                                  <ActivityIndicator
                                    color={colors.accentPrimary}
                                    size="small"
                                  />
                                </View>
                              )
                            ) : (
                              <View style={[styles.reviewThumb, styles.reviewThumbEmpty]}>
                                <Ionicons name="receipt" size={20} color={colors.oliveMid} />
                              </View>
                            )}
                            <View style={styles.reviewBody}>
                              <AppText variant="numeric" style={styles.reviewAmount}>
                                {formatMoney(receipt.amount)}
                              </AppText>
                              <AppText variant="bodyStrong">
                                {receipt.description ?? 'No description'}
                              </AppText>
                              <AppText variant="caption" color={colors.textMuted}>
                                {receipt.employee} ·{' '}
                                {formatShortDate(receipt.created_at.slice(0, 10))}
                              </AppText>
                              <View style={styles.pillRow}>
                                <Pill
                                  label={categoryLabel(receipt.category)}
                                  bg={colors.skySoft}
                                  fg={colors.ocean}
                                />
                                {jobLabel(receipt.job_id) ? (
                                  <Pill
                                    label={jobLabel(receipt.job_id) as string}
                                    bg={colors.oliveSoft}
                                    fg={colors.oliveDeep}
                                  />
                                ) : null}
                                {receipt.needs_reimbursed ? (
                                  <Pill
                                    label="Reimburse"
                                    bg={colors.amberSoft}
                                    fg={colors.amberDeep}
                                  />
                                ) : null}
                              </View>
                            </View>
                          </View>
                          <View style={styles.reviewButtons}>
                            <Button
                              label="Reject"
                              variant="danger"
                              size="sm"
                              disabled={reviewBusy[receipt.id]}
                              onPress={() => reject(receipt)}
                            />
                            <Button
                              label="Approve"
                              size="sm"
                              loading={reviewBusy[receipt.id]}
                              onPress={() => approve(receipt)}
                            />
                          </View>
                        </Card>
                      </FadeInUp>
                    ))}
                  </View>
                )}
              </View>
            ) : null}

            <View style={styles.section}>
              <SectionHeader title="Submit receipt" icon="camera-outline" />
              <Card style={styles.formCard}>
                {photo ? (
                  <View style={styles.photoRow}>
                    <Image
                      source={{ uri: photo.uri }}
                      style={styles.photoPreview}
                      contentFit="cover"
                    />
                    <AnimatedPressable
                      onPress={() => setPhoto(null)}
                      haptic="tapLight"
                      hitSlop={8}
                      accessibilityRole="button"
                      accessibilityLabel="Remove photo"
                      style={styles.photoRemove}>
                      <Ionicons name="close" size={16} color={colors.danger} />
                    </AnimatedPressable>
                  </View>
                ) : Platform.OS === 'web' ? (
                  <View style={styles.photoButtonRow}>
                    <Button
                      label="Camera"
                      icon="camera"
                      variant="secondary"
                      size="sm"
                      onPress={takePhoto}
                    />
                    <Button
                      label="Library"
                      icon="images"
                      variant="secondary"
                      size="sm"
                      onPress={pickFromLibrary}
                    />
                  </View>
                ) : (
                  <Button
                    label="Add receipt photo"
                    icon="camera"
                    variant="secondary"
                    size="sm"
                    onPress={choosePhotoSource}
                  />
                )}

                <AppText variant="section" color={colors.textMuted} style={styles.fieldLabel}>
                  Amount
                </AppText>
                <TextInput
                  value={amountText}
                  onChangeText={setAmountText}
                  placeholder="0.00"
                  placeholderTextColor={colors.textMuted}
                  keyboardType="decimal-pad"
                  style={styles.input}
                />

                <AppText variant="section" color={colors.textMuted} style={styles.fieldLabel}>
                  Description
                </AppText>
                <TextInput
                  value={description}
                  onChangeText={setDescription}
                  placeholder="What was purchased?"
                  placeholderTextColor={colors.textMuted}
                  style={styles.input}
                />

                <AppText variant="section" color={colors.textMuted} style={styles.fieldLabel}>
                  Category
                </AppText>
                <View style={styles.chipRow}>
                  {RECEIPT_CATEGORIES.map((c) => (
                    <Chip
                      key={c.value}
                      label={c.label}
                      tone="sun"
                      selected={category === c.value}
                      onPress={() => setCategory(c.value)}
                    />
                  ))}
                </View>

                <AppText variant="section" color={colors.textMuted} style={styles.fieldLabel}>
                  Payment method
                </AppText>
                <TextInput
                  value={method}
                  onChangeText={setMethod}
                  placeholder="e.g. debit card"
                  placeholderTextColor={colors.textMuted}
                  style={styles.input}
                />

                {jobs.length > 0 ? (
                  <>
                    <AppText variant="section" color={colors.textMuted} style={styles.fieldLabel}>
                      Job (optional)
                    </AppText>
                    <View style={styles.chipRow}>
                      <Chip
                        label="None"
                        tone="sun"
                        selected={jobId === null}
                        onPress={() => setJobId(null)}
                      />
                      {jobs.map((job) => (
                        <Chip
                          key={job.id}
                          label={job.job_number ? `Job ${job.job_number}` : job.name}
                          tone="sun"
                          selected={jobId === job.id}
                          onPress={() => setJobId(job.id)}
                        />
                      ))}
                    </View>
                  </>
                ) : null}

                <View style={styles.switchRow}>
                  <AppText variant="body" style={styles.switchLabel}>
                    I paid out of pocket — needs reimbursement
                  </AppText>
                  <Switch
                    value={needsReimbursed}
                    onValueChange={setNeedsReimbursed}
                    trackColor={{ false: colors.border, true: colors.accentAction }}
                    thumbColor={colors.white}
                  />
                </View>

                <Button
                  label="Submit receipt"
                  icon="paper-plane"
                  loading={submitting}
                  fullWidth
                  onPress={submit}
                  style={styles.submit}
                />
              </Card>
            </View>

            <View style={styles.section}>
              <SectionHeader title="My receipts" icon="receipt-outline" />
              {mineState === 'loading' ? (
                <SkeletonList count={3} height={64} />
              ) : mineState === 'unavailable' ? (
                <Card>
                  <EmptyState
                    icon="cloud-offline-outline"
                    title="Receipts are unavailable right now."
                    body="Your list could not be loaded. Try again once you are back on a signal."
                  />
                </Card>
              ) : mine.length === 0 ? (
                <Card>
                  <EmptyState
                    icon="receipt"
                    title="No receipts yet."
                    body="Anything you submit above shows up here with its review status."
                  />
                </Card>
              ) : (
                <Card padded={false}>
                  {mine.map((receipt, index) => (
                    <FadeInUp key={receipt.id} index={index}>
                      <View style={[styles.mineRow, index > 0 && styles.rowBorderTop]}>
                        <View style={styles.mineBody}>
                          <AppText variant="bodyStrong">{formatMoney(receipt.amount)}</AppText>
                          <AppText variant="body" numberOfLines={2}>
                            {receipt.description ?? 'No description'}
                          </AppText>
                          <AppText variant="caption" color={colors.textMuted}>
                            {formatShortDate(receipt.created_at.slice(0, 10))} ·{' '}
                            {categoryLabel(receipt.category)}
                          </AppText>
                        </View>
                        <View style={styles.minePills}>
                          {renderStatusPill(receipt.status)}
                          {receipt.needs_reimbursed ? (
                            <Pill
                              label="Reimburse"
                              bg={colors.amberSoft}
                              fg={colors.amberDeep}
                            />
                          ) : null}
                        </View>
                      </View>
                    </FadeInUp>
                  ))}
                </Card>
              )}
            </View>
          </>
        )}

        {status ? (
          <AppText
            variant="caption"
            align="center"
            color={status.kind === 'error' ? colors.danger : colors.success}>
            {status.message}
          </AppText>
        ) : null}
      </Screen>
    </>
  );
}

const styles = StyleSheet.create({
  section: {
    marginTop: spacing.sm,
  },
  stack: {
    gap: spacing.md,
  },
  // Admin review
  reviewCard: {
    gap: spacing.sm,
  },
  reviewTop: {
    flexDirection: 'row',
    gap: spacing.md,
  },
  reviewThumb: {
    width: 72,
    height: 72,
    borderRadius: radii.sm,
    backgroundColor: colors.surfaceSunk,
  },
  reviewThumbEmpty: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  reviewBody: {
    flex: 1,
    gap: 2,
  },
  reviewAmount: {
    fontSize: 18,
    lineHeight: 24,
  },
  pillRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.xs,
    marginTop: spacing.xs,
  },
  reviewButtons: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    alignItems: 'center',
    gap: spacing.sm,
    marginTop: spacing.xs,
  },
  // Form
  formCard: {
    gap: spacing.sm,
  },
  photoRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: spacing.sm,
  },
  photoPreview: {
    width: 96,
    height: 96,
    borderRadius: radii.sm,
    backgroundColor: colors.surfaceSunk,
  },
  photoRemove: {
    width: 28,
    height: 28,
    borderRadius: radii.pill,
    backgroundColor: colors.dangerSoft,
    alignItems: 'center',
    justifyContent: 'center',
  },
  photoButtonRow: {
    flexDirection: 'row',
    gap: spacing.sm,
  },
  fieldLabel: {
    marginTop: spacing.xs,
  },
  input: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radii.sm,
    paddingHorizontal: spacing.sm + 4,
    paddingVertical: spacing.sm,
    color: colors.textPrimary,
    fontSize: 15,
    backgroundColor: colors.surfaceSunk,
  },
  chipRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.xs,
  },
  switchRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.md,
    marginTop: spacing.xs,
  },
  switchLabel: {
    flex: 1,
  },
  submit: {
    marginTop: spacing.sm,
  },
  // My receipts
  mineRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm + 2,
  },
  rowBorderTop: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
  },
  mineBody: {
    flex: 1,
    gap: 2,
  },
  minePills: {
    alignItems: 'flex-end',
    gap: spacing.xs,
  },
});
