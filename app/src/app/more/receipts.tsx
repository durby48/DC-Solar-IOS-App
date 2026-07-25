import Ionicons from '@expo/vector-icons/Ionicons';
import { Image } from 'expo-image';
import * as ImagePicker from 'expo-image-picker';
import { Stack } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  View,
} from 'react-native';

import { colors, radii, shadows, spacing } from '@/constants/theme';
import { formatShortDate } from '@/lib/dates';
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

const STATUS_PILLS: Record<ReceiptStatus, { bg: string; text: string; label: string }> = {
  pending: { bg: colors.sunLight, text: colors.ink, label: 'Pending' },
  approved: { bg: colors.skySoft, text: colors.ocean, label: 'Approved' },
  rejected: { bg: colors.cream, text: colors.danger, label: 'Rejected' },
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
    return (
      <View style={[styles.pill, { backgroundColor: pill.bg }]}>
        <Text style={[styles.pillText, { color: pill.text }]}>{pill.label}</Text>
      </View>
    );
  };

  return (
    <>
      <Stack.Screen options={{ title: 'Receipts' }} />
      <ScrollView
        style={styles.screen}
        contentContainerStyle={styles.container}
        keyboardShouldPersistTaps="handled">
        {auth.state === 'loading' ? (
          <View style={styles.centerCard}>
            <ActivityIndicator color={colors.ocean} />
          </View>
        ) : auth.state === 'out' ? (
          <View style={styles.centerCard}>
            <View style={styles.badge}>
              <Ionicons name="receipt" size={26} color={colors.ocean} />
            </View>
            <Text style={styles.promptTitle}>Sign in to submit receipts</Text>
            <Text style={styles.promptText}>
              Receipts are tied to your account so the office can review and reimburse them.
            </Text>
          </View>
        ) : (
          <>
            {isAdmin ? (
              <>
                <Text style={styles.sectionTitle}>Pending review</Text>
                {pendingState === 'loading' ? (
                  <View style={styles.centerCard}>
                    <ActivityIndicator color={colors.ocean} />
                  </View>
                ) : pendingState === 'unavailable' ? (
                  <View style={styles.centerCard}>
                    <Text style={styles.promptText}>Pending receipts are unavailable right now.</Text>
                  </View>
                ) : pending.length === 0 ? (
                  <View style={styles.centerCard}>
                    <Ionicons name="checkmark-circle" size={22} color={colors.ocean} />
                    <Text style={styles.promptText}>No receipts waiting for review.</Text>
                  </View>
                ) : (
                  pending.map((receipt) => (
                    <View key={receipt.id} style={styles.card}>
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
                              <ActivityIndicator color={colors.ocean} size="small" />
                            </View>
                          )
                        ) : (
                          <View style={[styles.reviewThumb, styles.reviewThumbEmpty]}>
                            <Ionicons name="receipt" size={20} color={colors.inkSoft} />
                          </View>
                        )}
                        <View style={styles.reviewBody}>
                          <Text style={styles.reviewAmount}>{formatMoney(receipt.amount)}</Text>
                          <Text style={styles.reviewDescription}>
                            {receipt.description ?? 'No description'}
                          </Text>
                          <Text style={styles.reviewMeta}>
                            {receipt.employee} · {formatShortDate(receipt.created_at.slice(0, 10))}
                          </Text>
                          <View style={styles.pillRow}>
                            <View style={[styles.pill, { backgroundColor: colors.skySoft }]}>
                              <Text style={[styles.pillText, { color: colors.ocean }]}>
                                {categoryLabel(receipt.category)}
                              </Text>
                            </View>
                            {jobLabel(receipt.job_id) ? (
                              <View style={[styles.pill, { backgroundColor: colors.tan }]}>
                                <Text style={[styles.pillText, { color: colors.inkSoft }]}>
                                  {jobLabel(receipt.job_id)}
                                </Text>
                              </View>
                            ) : null}
                            {receipt.needs_reimbursed ? (
                              <View style={[styles.pill, { backgroundColor: colors.sunLight }]}>
                                <Text style={[styles.pillText, { color: colors.ink }]}>
                                  Reimburse
                                </Text>
                              </View>
                            ) : null}
                          </View>
                        </View>
                      </View>
                      <View style={styles.reviewButtons}>
                        <Pressable
                          onPress={() => reject(receipt)}
                          disabled={reviewBusy[receipt.id]}
                          style={({ pressed }) => [
                            styles.rejectButton,
                            (pressed || reviewBusy[receipt.id]) && styles.pressed,
                          ]}>
                          <Text style={styles.rejectButtonText}>Reject</Text>
                        </Pressable>
                        <Pressable
                          onPress={() => approve(receipt)}
                          disabled={reviewBusy[receipt.id]}
                          style={({ pressed }) => [
                            styles.approveButton,
                            (pressed || reviewBusy[receipt.id]) && styles.pressed,
                          ]}>
                          {reviewBusy[receipt.id] ? (
                            <ActivityIndicator color={colors.ink} size="small" />
                          ) : (
                            <Text style={styles.approveButtonText}>Approve</Text>
                          )}
                        </Pressable>
                      </View>
                    </View>
                  ))
                )}
              </>
            ) : null}

            <Text style={styles.sectionTitle}>Submit receipt</Text>
            <View style={styles.card}>
              {photo ? (
                <View style={styles.photoRow}>
                  <Image source={{ uri: photo.uri }} style={styles.photoPreview} contentFit="cover" />
                  <Pressable onPress={() => setPhoto(null)} hitSlop={8} style={styles.photoRemove}>
                    <Ionicons name="close" size={16} color={colors.danger} />
                  </Pressable>
                </View>
              ) : Platform.OS === 'web' ? (
                <View style={styles.photoButtonRow}>
                  <Pressable
                    onPress={takePhoto}
                    style={({ pressed }) => [styles.photoButton, pressed && styles.pressed]}>
                    <Ionicons name="camera" size={16} color={colors.ink} />
                    <Text style={styles.photoButtonText}>Camera</Text>
                  </Pressable>
                  <Pressable
                    onPress={pickFromLibrary}
                    style={({ pressed }) => [styles.photoButton, pressed && styles.pressed]}>
                    <Ionicons name="images" size={16} color={colors.ink} />
                    <Text style={styles.photoButtonText}>Library</Text>
                  </Pressable>
                </View>
              ) : (
                <Pressable
                  onPress={choosePhotoSource}
                  style={({ pressed }) => [styles.photoButton, pressed && styles.pressed]}>
                  <Ionicons name="camera" size={16} color={colors.ink} />
                  <Text style={styles.photoButtonText}>Add receipt photo</Text>
                </Pressable>
              )}

              <Text style={styles.fieldLabel}>Amount</Text>
              <TextInput
                value={amountText}
                onChangeText={setAmountText}
                placeholder="0.00"
                placeholderTextColor={colors.inkSoft}
                keyboardType="decimal-pad"
                style={styles.input}
              />

              <Text style={styles.fieldLabel}>Description</Text>
              <TextInput
                value={description}
                onChangeText={setDescription}
                placeholder="What was purchased?"
                placeholderTextColor={colors.inkSoft}
                style={styles.input}
              />

              <Text style={styles.fieldLabel}>Category</Text>
              <View style={styles.chipRow}>
                {RECEIPT_CATEGORIES.map((c) => (
                  <Pressable
                    key={c.value}
                    onPress={() => setCategory(c.value)}
                    style={[styles.chip, category === c.value && styles.chipSelected]}>
                    <Text
                      style={[styles.chipText, category === c.value && styles.chipTextSelected]}>
                      {c.label}
                    </Text>
                  </Pressable>
                ))}
              </View>

              <Text style={styles.fieldLabel}>Payment method</Text>
              <TextInput
                value={method}
                onChangeText={setMethod}
                placeholder="e.g. debit card"
                placeholderTextColor={colors.inkSoft}
                style={styles.input}
              />

              {jobs.length > 0 ? (
                <>
                  <Text style={styles.fieldLabel}>Job (optional)</Text>
                  <View style={styles.chipRow}>
                    <Pressable
                      onPress={() => setJobId(null)}
                      style={[styles.chip, jobId === null && styles.chipSelected]}>
                      <Text style={[styles.chipText, jobId === null && styles.chipTextSelected]}>
                        None
                      </Text>
                    </Pressable>
                    {jobs.map((job) => (
                      <Pressable
                        key={job.id}
                        onPress={() => setJobId(job.id)}
                        style={[styles.chip, jobId === job.id && styles.chipSelected]}>
                        <Text
                          style={[styles.chipText, jobId === job.id && styles.chipTextSelected]}>
                          {job.job_number ? `Job ${job.job_number}` : job.name}
                        </Text>
                      </Pressable>
                    ))}
                  </View>
                </>
              ) : null}

              <View style={styles.switchRow}>
                <Text style={styles.switchLabel}>I paid out of pocket — needs reimbursement</Text>
                <Switch
                  value={needsReimbursed}
                  onValueChange={setNeedsReimbursed}
                  trackColor={{ false: colors.tan, true: colors.sun }}
                  thumbColor={colors.white}
                />
              </View>

              <Pressable
                onPress={submit}
                disabled={submitting}
                style={({ pressed }) => [
                  styles.submitButton,
                  (pressed || submitting) && styles.pressed,
                ]}>
                {submitting ? (
                  <ActivityIndicator color={colors.ink} size="small" />
                ) : (
                  <>
                    <Ionicons name="paper-plane" size={16} color={colors.ink} />
                    <Text style={styles.submitButtonText}>Submit receipt</Text>
                  </>
                )}
              </Pressable>
            </View>

            <Text style={styles.sectionTitle}>My receipts</Text>
            {mineState === 'loading' ? (
              <View style={styles.centerCard}>
                <ActivityIndicator color={colors.ocean} />
              </View>
            ) : mineState === 'unavailable' ? (
              <View style={styles.centerCard}>
                <Text style={styles.promptText}>Receipts are unavailable right now.</Text>
              </View>
            ) : mine.length === 0 ? (
              <View style={styles.centerCard}>
                <Ionicons name="receipt" size={22} color={colors.inkSoft} />
                <Text style={styles.promptText}>No receipts yet.</Text>
              </View>
            ) : (
              <View style={styles.card}>
                {mine.map((receipt, index) => (
                  <View
                    key={receipt.id}
                    style={[styles.mineRow, index > 0 && styles.rowBorderTop]}>
                    <View style={styles.mineBody}>
                      <Text style={styles.mineAmount}>{formatMoney(receipt.amount)}</Text>
                      <Text style={styles.mineDescription} numberOfLines={2}>
                        {receipt.description ?? 'No description'}
                      </Text>
                      <Text style={styles.mineMeta}>
                        {formatShortDate(receipt.created_at.slice(0, 10))} ·{' '}
                        {categoryLabel(receipt.category)}
                      </Text>
                    </View>
                    <View style={styles.minePills}>
                      {renderStatusPill(receipt.status)}
                      {receipt.needs_reimbursed ? (
                        <View style={[styles.pill, { backgroundColor: colors.sunLight }]}>
                          <Text style={[styles.pillText, { color: colors.ink }]}>Reimburse</Text>
                        </View>
                      ) : null}
                    </View>
                  </View>
                ))}
              </View>
            )}
          </>
        )}

        {status ? (
          <Text
            style={[
              styles.statusText,
              status.kind === 'error' ? styles.statusError : styles.statusSuccess,
            ]}>
            {status.message}
          </Text>
        ) : null}
      </ScrollView>
    </>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: colors.cream,
  },
  container: {
    padding: spacing.lg,
    gap: spacing.md,
    paddingBottom: spacing.xxl,
  },
  sectionTitle: {
    color: colors.ink,
    fontSize: 18,
    fontWeight: '700',
    marginTop: spacing.sm,
  },
  centerCard: {
    backgroundColor: colors.skySoft,
    borderRadius: radii.md,
    padding: spacing.lg,
    alignItems: 'center',
    gap: spacing.sm,
  },
  badge: {
    width: 56,
    height: 56,
    borderRadius: radii.lg,
    backgroundColor: colors.white,
    alignItems: 'center',
    justifyContent: 'center',
  },
  promptTitle: {
    color: colors.ink,
    fontSize: 17,
    fontWeight: '800',
    textAlign: 'center',
  },
  promptText: {
    color: colors.inkSoft,
    fontSize: 14,
    fontWeight: '600',
    textAlign: 'center',
  },
  card: {
    backgroundColor: colors.white,
    borderRadius: radii.md,
    padding: spacing.md,
    gap: spacing.sm,
    ...shadows.card,
  },
  pressed: {
    opacity: 0.7,
  },
  // Admin review
  reviewTop: {
    flexDirection: 'row',
    gap: spacing.md,
  },
  reviewThumb: {
    width: 72,
    height: 72,
    borderRadius: radii.sm,
    backgroundColor: colors.skySoft,
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
    color: colors.ink,
    fontSize: 18,
    fontWeight: '800',
  },
  reviewDescription: {
    color: colors.ink,
    fontSize: 14,
    fontWeight: '600',
  },
  reviewMeta: {
    color: colors.inkSoft,
    fontSize: 12,
    fontWeight: '600',
  },
  pillRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.xs,
    marginTop: spacing.xs,
  },
  pill: {
    borderRadius: radii.pill,
    paddingHorizontal: spacing.sm,
    paddingVertical: 3,
  },
  pillText: {
    fontSize: 11,
    fontWeight: '800',
  },
  reviewButtons: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    gap: spacing.sm,
    marginTop: spacing.xs,
  },
  rejectButton: {
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.md,
    borderRadius: radii.pill,
    borderWidth: 1,
    borderColor: colors.danger,
  },
  rejectButtonText: {
    color: colors.danger,
    fontSize: 14,
    fontWeight: '800',
  },
  approveButton: {
    backgroundColor: colors.sun,
    borderRadius: radii.pill,
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.lg,
    alignItems: 'center',
    justifyContent: 'center',
  },
  approveButtonText: {
    color: colors.ink,
    fontSize: 14,
    fontWeight: '800',
  },
  // Form
  photoRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: spacing.sm,
  },
  photoPreview: {
    width: 96,
    height: 96,
    borderRadius: radii.sm,
    backgroundColor: colors.skySoft,
  },
  photoRemove: {
    width: 28,
    height: 28,
    borderRadius: radii.pill,
    backgroundColor: colors.cream,
    alignItems: 'center',
    justifyContent: 'center',
  },
  photoButtonRow: {
    flexDirection: 'row',
    gap: spacing.sm,
  },
  photoButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.xs,
    backgroundColor: colors.sunLight,
    borderRadius: radii.pill,
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.md,
    alignSelf: 'flex-start',
  },
  photoButtonText: {
    color: colors.ink,
    fontSize: 13,
    fontWeight: '800',
  },
  fieldLabel: {
    color: colors.inkSoft,
    fontSize: 12,
    fontWeight: '700',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginTop: spacing.xs,
  },
  input: {
    borderWidth: 1,
    borderColor: colors.tan,
    borderRadius: radii.sm,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.sm,
    color: colors.ink,
    fontSize: 15,
    fontWeight: '600',
    backgroundColor: colors.cream,
  },
  chipRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.xs,
  },
  chip: {
    borderRadius: radii.pill,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs + 2,
    backgroundColor: colors.cream,
    borderWidth: 1,
    borderColor: colors.tan,
  },
  chipSelected: {
    backgroundColor: colors.sun,
    borderColor: colors.sun,
  },
  chipText: {
    color: colors.inkSoft,
    fontSize: 13,
    fontWeight: '700',
  },
  chipTextSelected: {
    color: colors.ink,
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
    color: colors.ink,
    fontSize: 14,
    fontWeight: '600',
  },
  submitButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.sm,
    backgroundColor: colors.sun,
    borderRadius: radii.pill,
    paddingVertical: spacing.md - 2,
    paddingHorizontal: spacing.lg,
    marginTop: spacing.sm,
    ...shadows.card,
  },
  submitButtonText: {
    color: colors.ink,
    fontSize: 15,
    fontWeight: '800',
  },
  // My receipts
  mineRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingVertical: spacing.sm,
  },
  rowBorderTop: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.tan,
  },
  mineBody: {
    flex: 1,
    gap: 2,
  },
  mineAmount: {
    color: colors.ink,
    fontSize: 16,
    fontWeight: '800',
  },
  mineDescription: {
    color: colors.ink,
    fontSize: 13,
    fontWeight: '600',
  },
  mineMeta: {
    color: colors.inkSoft,
    fontSize: 12,
    fontWeight: '600',
  },
  minePills: {
    alignItems: 'flex-end',
    gap: spacing.xs,
  },
  statusText: {
    fontSize: 13,
    fontWeight: '600',
    textAlign: 'center',
  },
  statusError: {
    color: colors.danger,
  },
  statusSuccess: {
    color: colors.ocean,
  },
});
