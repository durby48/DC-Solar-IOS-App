import Ionicons from '@expo/vector-icons/Ionicons';
import * as DocumentPicker from 'expo-document-picker';
import * as ImagePicker from 'expo-image-picker';
import { Stack, useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Linking,
  Platform,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';

import { CustomerAvatar } from '@/components/CustomerAvatar';
import { PhoneActionSheet } from '@/components/PhoneActionSheet';
import { StatusPill } from '@/components/StatusPill';
import { colors, radii, shadows, spacing } from '@/constants/theme';
import { fetchEnrolledCustomerIds, inviteCustomer } from '@/lib/account';
import {
  addCustomerNote,
  archiveCustomer,
  deleteCustomerNote,
  fetchCrmCustomers,
  fetchCustomerById,
  fetchCustomerFinance,
  fetchCustomerJobs,
  fetchCustomerNotes,
  fetchCustomerSummaries,
  mergeCustomers,
  unarchiveCustomer,
  updateCustomer,
  updateCustomerNote,
  type CustomerFinanceRow,
  type CustomerJob,
  type CustomerNote,
  type CustomerSummary,
} from '@/lib/crm';
import {
  deleteCustomerDocument,
  fetchCustomerDocuments,
  uploadCustomerDocument,
  uploadCustomerPhoto,
  type CustomerDocument,
} from '@/lib/customers';
import { getDocumentUrl } from '@/lib/data';
import { formatShortDate } from '@/lib/dates';
import { shareDocument, viewDocument } from '@/lib/pdf';
import { useRole } from '@/lib/role';
import { labelForJob } from '@/lib/stages';
import { supabase } from '@/lib/supabase';
import { type Customer } from '@/lib/types';

/**
 * The customer record — six segments over one person.
 *
 * Overview · Jobs · Documents · Money · Comms · Notes, with Money and Comms
 * shown to admins only. THAT GATE IS COSMETIC. `finance_entries` and
 * `messages` are admin-only in RLS and `crm_customer_summary` returns zero
 * rows to a viewer; hiding the tabs just stops a crew member tapping into a
 * screen that would be empty anyway.
 *
 * Everything `more/customers.tsx` could do lives here: the avatar picker, the
 * three tappable contact rows, the inline edit form, the Invite button and the
 * insurance-document list (upload / open / share / two-tap delete). What is
 * new is jobs, money, paperwork, notes, archive and merge.
 */

type Segment = 'overview' | 'jobs' | 'documents' | 'money' | 'comms' | 'notes';

const ALL_SEGMENTS: { key: Segment; label: string; adminOnly: boolean }[] = [
  { key: 'overview', label: 'Overview', adminOnly: false },
  { key: 'jobs', label: 'Jobs', adminOnly: false },
  { key: 'documents', label: 'Documents', adminOnly: false },
  { key: 'money', label: 'Money', adminOnly: true },
  { key: 'comms', label: 'Comms', adminOnly: true },
  { key: 'notes', label: 'Notes', adminOnly: false },
];

function money(amount: number): string {
  return `$${amount.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function moneyShort(amount: number): string {
  return `$${Math.round(amount).toLocaleString('en-US')}`;
}

/** "just now" / "4 hours ago" / "12 Aug" — enough to place a note in time. */
function relativeTime(iso: string): string {
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return '';
  const seconds = Math.max(0, Math.round((Date.now() - then) / 1000));
  if (seconds < 90) return 'just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return hours === 1 ? '1 hour ago' : `${hours} hours ago`;
  const days = Math.round(hours / 24);
  if (days < 7) return days === 1 ? 'yesterday' : `${days} days ago`;
  return formatShortDate(iso.slice(0, 10));
}

/** "devonsd311@gmail.com" → "Devonsd311". Good enough to attribute a note. */
function authorName(email: string): string {
  const local = (email ?? '').split('@')[0] ?? '';
  const first = local.split(/[._-]/)[0] ?? local;
  if (!first) return 'Someone';
  return first.charAt(0).toUpperCase() + first.slice(1);
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

function openUrl(url: string) {
  Linking.openURL(url).catch(() => {});
}

interface FormState {
  name: string;
  phone: string;
  email: string;
  address: string;
  notes: string;
}

export default function CustomerDetailScreen() {
  const params = useLocalSearchParams<{ id?: string }>();
  const customerId = typeof params.id === 'string' ? params.id : '';
  const router = useRouter();
  const role = useRole();
  const isAdmin = role?.isAdmin ?? false;

  const [authState, setAuthState] = useState<'loading' | 'out' | 'in'>('loading');
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [notFound, setNotFound] = useState(false);
  const [segment, setSegment] = useState<Segment>('overview');

  const [customer, setCustomer] = useState<Customer | null>(null);
  const [jobs, setJobs] = useState<CustomerJob[]>([]);
  const [finance, setFinance] = useState<CustomerFinanceRow[]>([]);
  const [summary, setSummary] = useState<CustomerSummary | null>(null);
  const [notes, setNotes] = useState<CustomerNote[]>([]);
  const [notesAvailable, setNotesAvailable] = useState(true);
  const [insurance, setInsurance] = useState<CustomerDocument[] | null>(null);
  const [enrolled, setEnrolled] = useState(false);

  const [status, setStatus] = useState<{ kind: 'success' | 'error'; message: string } | null>(null);

  // Overview
  const [showPhoneSheet, setShowPhoneSheet] = useState(false);
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState<FormState>({
    name: '',
    phone: '',
    email: '',
    address: '',
    notes: '',
  });
  const [savingEdit, setSavingEdit] = useState(false);
  const [photoBusy, setPhotoBusy] = useState(false);
  const [inviteBusy, setInviteBusy] = useState(false);
  const [confirmArchive, setConfirmArchive] = useState(false);
  const [archiveBusy, setArchiveBusy] = useState(false);

  // Merge
  const [showMerge, setShowMerge] = useState(false);
  const [mergeSearch, setMergeSearch] = useState('');
  const [mergeCandidates, setMergeCandidates] = useState<Customer[]>([]);
  const [confirmMergeId, setConfirmMergeId] = useState<string | null>(null);
  const [mergeBusy, setMergeBusy] = useState(false);

  // Documents
  const [busyDocId, setBusyDocId] = useState<string | null>(null);
  const [confirmDeleteDocId, setConfirmDeleteDocId] = useState<string | null>(null);
  const [uploadingInsurance, setUploadingInsurance] = useState(false);

  // Notes
  const [noteDraft, setNoteDraft] = useState('');
  const [savingNote, setSavingNote] = useState(false);
  const [editNoteId, setEditNoteId] = useState<string | null>(null);
  const [editNoteBody, setEditNoteBody] = useState('');
  const [confirmDeleteNoteId, setConfirmDeleteNoteId] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    supabase.auth.getSession().then(({ data }) => {
      if (cancelled) return;
      setAuthState(data.session?.user?.email ? 'in' : 'out');
    });
    const { data: sub } = supabase.auth.onAuthStateChange((_event, session) => {
      if (cancelled) return;
      setAuthState(session?.user?.email ? 'in' : 'out');
    });
    return () => {
      cancelled = true;
      sub.subscription.unsubscribe();
    };
  }, []);

  const load = useCallback(async () => {
    if (!customerId) {
      setNotFound(true);
      setLoading(false);
      return;
    }
    const [record, jobRows, noteResult, enrolledIds, docMap] = await Promise.all([
      fetchCustomerById(customerId),
      fetchCustomerJobs(customerId),
      fetchCustomerNotes(customerId),
      fetchEnrolledCustomerIds(),
      fetchCustomerDocuments(),
    ]);

    if (!record) {
      setNotFound(true);
      setLoading(false);
      return;
    }

    setNotFound(false);
    setCustomer(record);
    setJobs(jobRows);
    setEnrolled(enrolledIds.has(customerId));
    setInsurance(docMap ? (docMap.get(customerId) ?? []) : null);
    if (noteResult.status === 'ok') {
      setNotes(noteResult.notes);
      setNotesAvailable(true);
    } else {
      setNotes([]);
      setNotesAvailable(false);
    }
    setForm({
      name: record.name,
      phone: record.phone ?? '',
      email: record.email ?? '',
      address: record.address ?? '',
      notes: record.notes ?? '',
    });

    // Second wave: both need the job ids the first wave returned.
    const [financeResult, summaryMap] = await Promise.all([
      fetchCustomerFinance(
        customerId,
        jobRows.map((j) => j.id),
      ),
      fetchCustomerSummaries([customerId]),
    ]);
    setFinance(financeResult.status === 'ok' ? financeResult.entries : []);
    setSummary(summaryMap.get(customerId) ?? null);
    setLoading(false);
  }, [customerId]);

  // One loader: `useFocusEffect` re-runs when its callback identity changes
  // while focused, so it covers the first load (auth resolving) as well as
  // every return to the screen. A plain useEffect alongside it would double
  // every fetch on mount.
  useFocusEffect(
    useCallback(() => {
      if (authState === 'out') {
        setLoading(false);
        return;
      }
      if (authState !== 'in') return;
      void load();
    }, [authState, load]),
  );

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  }, [load]);

  const segments = useMemo(
    () => ALL_SEGMENTS.filter((s) => !s.adminOnly || isAdmin),
    [isAdmin],
  );

  // A viewer who deep-links to ?segment=money would land on a hidden tab.
  useEffect(() => {
    if (!segments.some((s) => s.key === segment)) setSegment('overview');
  }, [segments, segment]);

  // -------------------------------------------------------------------------
  // Actions
  // -------------------------------------------------------------------------

  /**
   * Same options as the old Customers screen: `allowsEditing` with a 1:1
   * aspect makes the OS crop it square, which is the only sizing lever we
   * have — there is no image-processing library in the bundle.
   */
  const pickPhoto = async () => {
    if (!customer) return;
    setStatus(null);
    try {
      const result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ['images'],
        allowsEditing: true,
        aspect: [1, 1],
        quality: 0.6,
      });
      if (result.canceled || !result.assets?.length) return;
      setPhotoBusy(true);
      const upload = await uploadCustomerPhoto({
        customerId: customer.id,
        uri: result.assets[0].uri,
      });
      setPhotoBusy(false);
      if (upload.ok) {
        await load();
        notify(setStatus, 'success', 'Photo saved', `Contact photo updated for ${customer.name}.`);
      } else {
        notify(setStatus, 'error', 'Photo failed', upload.message);
      }
    } catch {
      setPhotoBusy(false);
      notify(setStatus, 'error', 'Photo failed', 'Something went wrong. Please try again.');
    }
  };

  const saveEdit = async () => {
    if (!customer) return;
    setStatus(null);
    if (!form.name.trim()) {
      notify(setStatus, 'error', 'Missing name', 'The customer needs a name.');
      return;
    }
    setSavingEdit(true);
    const result = await updateCustomer(customer.id, {
      name: form.name.trim(),
      phone: form.phone.trim() || null,
      email: form.email.trim() || null,
      address: form.address.trim() || null,
      notes: form.notes.trim() || null,
    });
    setSavingEdit(false);
    if (result.ok) {
      setEditing(false);
      await load();
      notify(setStatus, 'success', 'Saved', `${form.name.trim()} updated.`);
    } else {
      notify(setStatus, 'error', 'Could not save', result.message);
    }
  };

  const sendInvite = async () => {
    if (!customer) return;
    setStatus(null);
    setInviteBusy(true);
    const result = await inviteCustomer(customer.id);
    setInviteBusy(false);
    if (result.ok) {
      setEnrolled(true);
      notify(
        setStatus,
        'success',
        result.alreadyInvited ? 'Already invited' : 'Invite sent',
        result.alreadyInvited
          ? `${customer.name} already has a portal login.`
          : `Emailed ${result.email} an invitation to the customer portal.`,
      );
    } else {
      notify(setStatus, 'error', 'Invite failed', result.message);
    }
  };

  const pressArchive = async () => {
    if (!customer) return;
    const archived = customer.archived_at != null;
    if (!archived && !confirmArchive) {
      setStatus(null);
      setConfirmArchive(true);
      return;
    }
    setConfirmArchive(false);
    setArchiveBusy(true);
    const result = archived
      ? await unarchiveCustomer(customer.id, customer.name)
      : await archiveCustomer(customer.id);
    setArchiveBusy(false);
    if (result.ok) {
      await load();
      notify(
        setStatus,
        'success',
        archived ? 'Restored' : 'Archived',
        archived
          ? `${customer.name} is back in the customer list.`
          : `${customer.name} is hidden from the list. Nothing was deleted.`,
      );
    } else {
      notify(setStatus, 'error', archived ? 'Could not restore' : 'Could not archive', result.message);
    }
  };

  const openMerge = async () => {
    setStatus(null);
    setShowMerge(true);
    setConfirmMergeId(null);
    const result = await fetchCrmCustomers({ includeArchived: true });
    if (result.status === 'ok') {
      setMergeCandidates(result.customers.filter((c) => c.id !== customerId));
    }
  };

  const doMerge = async (keep: Customer) => {
    if (!customer) return;
    if (confirmMergeId !== keep.id) {
      setConfirmMergeId(keep.id);
      return;
    }
    setMergeBusy(true);
    const result = await mergeCustomers(keep.id, customer.id);
    setMergeBusy(false);
    setConfirmMergeId(null);
    if (!result.ok) {
      notify(setStatus, 'error', 'Could not merge', result.message);
      return;
    }
    setShowMerge(false);
    notify(
      setStatus,
      'success',
      'Merged',
      `${result.moved.jobs} jobs, ${result.moved.finance_entries} money rows and ${result.moved.customer_notes} notes moved to ${keep.name}. ${customer.name} was archived.`,
    );
    router.replace({ pathname: '/crm/[id]', params: { id: keep.id } });
  };

  const openPaperwork = async (path: string, revision: number | null) => {
    const url = await getDocumentUrl(path, revision);
    if (!url || !(await viewDocument(url))) {
      notify(setStatus, 'error', 'Could not open', 'Please try again.');
    }
  };

  const sharePaperwork = async (id: string, path: string, name: string, revision: number | null) => {
    setBusyDocId(id);
    try {
      const url = await getDocumentUrl(path, revision);
      if (!url || !(await shareDocument(url, name))) {
        notify(setStatus, 'error', 'Could not share', 'Please try again.');
      }
    } finally {
      setBusyDocId(null);
    }
  };

  const uploadInsurance = async () => {
    if (!customer) return;
    setStatus(null);
    try {
      const picked = await DocumentPicker.getDocumentAsync({
        type: 'application/pdf',
        copyToCacheDirectory: true,
        multiple: false,
      });
      if (picked.canceled || picked.assets.length === 0) return;
      const asset = picked.assets[0];
      setUploadingInsurance(true);
      const upload = await uploadCustomerDocument({
        customerId: customer.id,
        fileName: asset.name ?? 'insurance.pdf',
        uri: asset.uri,
        contentType: asset.mimeType ?? 'application/pdf',
      });
      setUploadingInsurance(false);
      if (upload.ok) {
        notify(setStatus, 'success', 'Uploaded', `Insurance saved for ${customer.name}.`);
        await load();
      } else {
        notify(setStatus, 'error', 'Upload failed', upload.message);
      }
    } catch (e) {
      setUploadingInsurance(false);
      notify(
        setStatus,
        'error',
        'Upload failed',
        e instanceof Error ? e.message : 'Something went wrong.',
      );
    }
  };

  const pressDeleteInsurance = async (doc: CustomerDocument) => {
    if (confirmDeleteDocId !== doc.id) {
      setStatus(null);
      setConfirmDeleteDocId(doc.id);
      return;
    }
    setConfirmDeleteDocId(null);
    setBusyDocId(doc.id);
    const result = await deleteCustomerDocument(doc);
    setBusyDocId(null);
    if (result.ok) {
      notify(setStatus, 'success', 'Deleted', `${doc.file_name} removed.`);
      await load();
    } else {
      notify(setStatus, 'error', 'Could not delete', result.message);
    }
  };

  const submitNote = async () => {
    if (!customer) return;
    setStatus(null);
    setSavingNote(true);
    const result = await addCustomerNote({ customerId: customer.id, body: noteDraft });
    setSavingNote(false);
    if (result.ok) {
      setNoteDraft('');
      await load();
    } else {
      notify(setStatus, 'error', 'Could not save note', result.message);
    }
  };

  const saveNoteEdit = async (note: CustomerNote) => {
    const result = await updateCustomerNote(note.id, { body: editNoteBody });
    if (result.ok) {
      setEditNoteId(null);
      setEditNoteBody('');
      await load();
    } else {
      notify(setStatus, 'error', 'Could not save note', result.message);
    }
  };

  const togglePin = async (note: CustomerNote) => {
    const result = await updateCustomerNote(note.id, { pinned: !note.pinned });
    if (result.ok) await load();
    else notify(setStatus, 'error', 'Could not pin that note', result.message);
  };

  const pressDeleteNote = async (note: CustomerNote) => {
    if (confirmDeleteNoteId !== note.id) {
      setConfirmDeleteNoteId(note.id);
      return;
    }
    setConfirmDeleteNoteId(null);
    const result = await deleteCustomerNote(note.id);
    if (result.ok) await load();
    else notify(setStatus, 'error', 'Could not delete note', result.message);
  };

  // -------------------------------------------------------------------------
  // Derived
  // -------------------------------------------------------------------------

  const paperwork = useMemo(
    () =>
      finance.filter(
        (row): row is CustomerFinanceRow & { document_path: string } =>
          typeof row.document_path === 'string' && row.document_path.length > 0,
      ),
    [finance],
  );

  const jobsById = useMemo(() => {
    const map = new Map<string, CustomerJob>();
    for (const job of jobs) map.set(job.id, job);
    return map;
  }, [jobs]);

  const financeByJob = useMemo(() => {
    const groups = new Map<string, CustomerFinanceRow[]>();
    for (const row of finance) {
      const key = row.job_id ?? 'none';
      const list = groups.get(key) ?? [];
      list.push(row);
      groups.set(key, list);
    }
    return groups;
  }, [finance]);

  const mergeMatches = useMemo(() => {
    const q = mergeSearch.trim().toLowerCase();
    if (!q) return mergeCandidates.slice(0, 12);
    return mergeCandidates.filter((c) => c.name.toLowerCase().includes(q)).slice(0, 12);
  }, [mergeCandidates, mergeSearch]);

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------

  if (authState === 'out') {
    return (
      <>
        <Stack.Screen options={{ title: 'Customer' }} />
        <ScrollView style={styles.screen} contentContainerStyle={styles.container}>
          <View style={styles.centerCard}>
            <View style={styles.badge}>
              <Ionicons name="people" size={26} color={colors.ocean} />
            </View>
            <Text style={styles.promptTitle}>Sign in to view customers</Text>
            <Text style={styles.promptText}>
              Customer contact details are only visible to signed-in crew members.
            </Text>
          </View>
        </ScrollView>
      </>
    );
  }

  if (loading) {
    return (
      <>
        <Stack.Screen options={{ title: 'Customer' }} />
        <View style={[styles.screen, styles.centerScreen]}>
          <ActivityIndicator color={colors.ocean} />
        </View>
      </>
    );
  }

  if (notFound || !customer) {
    return (
      <>
        <Stack.Screen options={{ title: 'Customer' }} />
        <ScrollView style={styles.screen} contentContainerStyle={styles.container}>
          <View style={styles.centerCard}>
            <Ionicons name="person-remove" size={22} color={colors.inkSoft} />
            <Text style={styles.promptText}>
              That customer could not be found. They may have been merged into another record.
            </Text>
          </View>
        </ScrollView>
      </>
    );
  }

  const archived = customer.archived_at != null;

  const contactRows: {
    key: string;
    icon: keyof typeof Ionicons.glyphMap;
    label: string;
    value: string;
    onPress: () => void;
  }[] = [];
  if (customer.phone) {
    contactRows.push({
      key: 'phone',
      icon: 'call',
      label: 'Phone',
      value: customer.phone,
      onPress: () => setShowPhoneSheet((v) => !v),
    });
  }
  if (customer.email) {
    const email = customer.email;
    contactRows.push({
      key: 'email',
      icon: 'mail',
      label: 'Email',
      value: email,
      onPress: () => openUrl('mailto:' + email),
    });
  }
  if (customer.address) {
    const address = customer.address;
    contactRows.push({
      key: 'address',
      icon: 'home',
      label: 'Address',
      value: address,
      onPress: () => openUrl('https://maps.apple.com/?daddr=' + encodeURIComponent(address)),
    });
  }

  const overview = (
    <>
      <View style={styles.card}>
        <View style={styles.identityRow}>
          <Pressable
            onPress={() => (isAdmin ? void pickPhoto() : undefined)}
            disabled={!isAdmin || photoBusy}
            hitSlop={6}>
            {photoBusy ? (
              <View style={styles.avatarBusy}>
                <ActivityIndicator color={colors.ocean} />
              </View>
            ) : (
              <CustomerAvatar customer={customer} size={72} />
            )}
          </Pressable>
          <View style={styles.identityBody}>
            <Text style={styles.identityName}>{customer.name}</Text>
            <Text style={styles.identityMeta}>
              {[
                jobs.length > 0 ? (jobs.length === 1 ? '1 job' : `${jobs.length} jobs`) : 'No jobs yet',
                enrolled ? 'In portal' : 'No portal login',
                archived ? 'Archived' : null,
              ]
                .filter(Boolean)
                .join(' · ')}
            </Text>
            {isAdmin ? <Text style={styles.hint}>Tap the photo to change it</Text> : null}
          </View>
        </View>
      </View>

      {archived ? (
        <View style={styles.noticeCard}>
          <Ionicons name="archive" size={16} color={colors.slateDeep} />
          <Text style={styles.noticeText}>
            This customer is archived — hidden from the list, but every job, invoice and payment is
            untouched.
          </Text>
        </View>
      ) : null}

      {editing && isAdmin ? (
        <View style={styles.card}>
          <Text style={styles.cardTitle}>Edit customer</Text>
          <Text style={styles.fieldLabel}>Name</Text>
          <TextInput
            value={form.name}
            onChangeText={(v) => setForm({ ...form, name: v })}
            placeholder="Full name"
            placeholderTextColor={colors.inkSoft}
            style={styles.input}
          />
          <Text style={styles.fieldLabel}>Phone (optional)</Text>
          <TextInput
            value={form.phone}
            onChangeText={(v) => setForm({ ...form, phone: v })}
            placeholder="e.g. (816) 555-0123"
            placeholderTextColor={colors.inkSoft}
            keyboardType="phone-pad"
            style={styles.input}
          />
          <Text style={styles.fieldLabel}>Email (optional)</Text>
          <TextInput
            value={form.email}
            onChangeText={(v) => setForm({ ...form, email: v })}
            placeholder="e.g. name@example.com"
            placeholderTextColor={colors.inkSoft}
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="email-address"
            style={styles.input}
          />
          <Text style={styles.fieldLabel}>Address (optional)</Text>
          <TextInput
            value={form.address}
            onChangeText={(v) => setForm({ ...form, address: v })}
            placeholder="Street, city, state"
            placeholderTextColor={colors.inkSoft}
            style={styles.input}
          />
          <Text style={styles.fieldLabel}>General notes (optional)</Text>
          <TextInput
            value={form.notes}
            onChangeText={(v) => setForm({ ...form, notes: v })}
            placeholder="Anything worth remembering"
            placeholderTextColor={colors.inkSoft}
            multiline
            style={[styles.input, styles.inputMultiline]}
          />
          <View style={styles.formButtons}>
            <Pressable
              onPress={() => {
                setEditing(false);
                setForm({
                  name: customer.name,
                  phone: customer.phone ?? '',
                  email: customer.email ?? '',
                  address: customer.address ?? '',
                  notes: customer.notes ?? '',
                });
              }}
              disabled={savingEdit}
              style={({ pressed }) => [styles.cancelButton, pressed && styles.pressed]}>
              <Text style={styles.cancelButtonText}>Cancel</Text>
            </Pressable>
            <Pressable
              onPress={() => void saveEdit()}
              disabled={savingEdit}
              style={({ pressed }) => [styles.saveButton, (pressed || savingEdit) && styles.pressed]}>
              {savingEdit ? (
                <ActivityIndicator color={colors.ink} size="small" />
              ) : (
                <Text style={styles.saveButtonText}>Save</Text>
              )}
            </Pressable>
          </View>
        </View>
      ) : (
        <View style={styles.card}>
          {contactRows.length === 0 ? (
            <Text style={styles.emptyText}>No phone, email or address on file.</Text>
          ) : (
            contactRows.map((row, index) => (
              <Pressable
                key={row.key}
                onPress={row.onPress}
                style={({ pressed }) => [
                  styles.contactRow,
                  index > 0 && styles.rowBorderTop,
                  pressed && styles.rowPressed,
                ]}>
                <View style={styles.iconWrap}>
                  <Ionicons name={row.icon} size={18} color={colors.ocean} />
                </View>
                <View style={styles.contactBody}>
                  <Text style={styles.fieldLabel}>{row.label}</Text>
                  <Text style={styles.contactValue}>{row.value}</Text>
                </View>
                <Ionicons name="chevron-forward" size={18} color={colors.inkSoft} />
              </Pressable>
            ))
          )}
          {showPhoneSheet && customer.phone ? (
            <View style={styles.sheetWrap}>
              <PhoneActionSheet
                phone={customer.phone}
                phoneE164={customer.phone_e164 ?? null}
                name={customer.name}
                isAdmin={isAdmin}
                optedOut={customer.sms_opt_out_at != null}
                onClose={() => setShowPhoneSheet(false)}
              />
            </View>
          ) : null}
          {customer.notes ? (
            <View style={[styles.notesBlock, styles.rowBorderTop]}>
              <Text style={styles.fieldLabel}>General notes</Text>
              <Text style={styles.bodyText}>{customer.notes}</Text>
            </View>
          ) : null}
        </View>
      )}

      <View style={styles.card}>
        <Text style={styles.cardTitle}>Customer portal</Text>
        <Text style={styles.bodyText}>
          {enrolled
            ? 'This customer can sign in and see their projects, documents and balance.'
            : 'Send an email invitation so they can see their projects, documents and balance.'}
        </Text>
        {isAdmin ? (
          <Pressable
            onPress={() => void sendInvite()}
            disabled={inviteBusy || enrolled || !customer.email}
            style={({ pressed }) => [
              styles.secondaryButton,
              (enrolled || !customer.email) && styles.buttonMuted,
              pressed && styles.pressed,
            ]}>
            {inviteBusy ? (
              <ActivityIndicator size="small" color={colors.ocean} />
            ) : (
              <Text style={styles.secondaryButtonText}>
                {enrolled ? 'In portal' : customer.email ? 'Send invite' : 'Add an email first'}
              </Text>
            )}
          </Pressable>
        ) : null}
      </View>

      {isAdmin ? (
        <View style={styles.card}>
          <Text style={styles.cardTitle}>Manage</Text>
          {!editing ? (
            <Pressable
              onPress={() => {
                setStatus(null);
                setEditing(true);
              }}
              style={({ pressed }) => [styles.manageRow, pressed && styles.rowPressed]}>
              <Ionicons name="pencil" size={16} color={colors.ocean} />
              <Text style={styles.manageText}>Edit details</Text>
            </Pressable>
          ) : null}

          <Pressable
            onPress={() => void pressArchive()}
            disabled={archiveBusy}
            style={({ pressed }) => [
              styles.manageRow,
              styles.rowBorderTop,
              pressed && styles.rowPressed,
            ]}>
            {archiveBusy ? (
              <ActivityIndicator size="small" color={colors.ocean} />
            ) : (
              <Ionicons
                name={archived ? 'arrow-undo' : 'archive'}
                size={16}
                color={confirmArchive ? colors.danger : colors.ocean}
              />
            )}
            <Text style={[styles.manageText, confirmArchive && styles.manageTextDanger]}>
              {archived
                ? 'Restore customer'
                : confirmArchive
                  ? 'Tap again to archive'
                  : 'Archive customer'}
            </Text>
          </Pressable>

          <Pressable
            onPress={() => (showMerge ? setShowMerge(false) : void openMerge())}
            style={({ pressed }) => [
              styles.manageRow,
              styles.rowBorderTop,
              pressed && styles.rowPressed,
            ]}>
            <Ionicons name="git-merge" size={16} color={colors.ocean} />
            <Text style={styles.manageText}>Merge into…</Text>
          </Pressable>

          {showMerge ? (
            <View style={styles.mergeArea}>
              <Text style={styles.hint}>
                Pick the record to KEEP. Every job, invoice, document and note on {customer.name}{' '}
                moves onto it and {customer.name} is archived. This cannot be undone from the app.
              </Text>
              <TextInput
                value={mergeSearch}
                onChangeText={setMergeSearch}
                placeholder="Search customers"
                placeholderTextColor={colors.inkSoft}
                style={styles.input}
              />
              {mergeMatches.length === 0 ? (
                <Text style={styles.emptyText}>No other customers match.</Text>
              ) : (
                mergeMatches.map((candidate) => (
                  <Pressable
                    key={candidate.id}
                    onPress={() => void doMerge(candidate)}
                    disabled={mergeBusy}
                    style={({ pressed }) => [
                      styles.mergeRow,
                      confirmMergeId === candidate.id && styles.mergeRowConfirm,
                      pressed && styles.rowPressed,
                    ]}>
                    <View style={styles.mergeBody}>
                      <Text style={styles.mergeName}>{candidate.name}</Text>
                      {candidate.address ? (
                        <Text style={styles.mergeMeta} numberOfLines={1}>
                          {candidate.address}
                        </Text>
                      ) : null}
                    </View>
                    <Text
                      style={[
                        styles.mergeAction,
                        confirmMergeId === candidate.id && styles.manageTextDanger,
                      ]}>
                      {confirmMergeId === candidate.id ? 'Tap again' : 'Merge'}
                    </Text>
                  </Pressable>
                ))
              )}
            </View>
          ) : null}
        </View>
      ) : null}
    </>
  );

  const jobsSegment = (
    <View style={styles.card}>
      <Text style={styles.cardTitle}>Projects</Text>
      {jobs.length === 0 ? (
        <Text style={styles.emptyText}>No projects for this customer yet.</Text>
      ) : (
        jobs.map((job, index) => {
          const when = job.completed_on
            ? `Completed ${formatShortDate(job.completed_on)}`
            : job.scheduled_for
              ? `Scheduled ${formatShortDate(job.scheduled_for)}`
              : 'Not scheduled';
          return (
            <Pressable
              key={job.id}
              onPress={() => router.push({ pathname: '/job/[id]', params: { id: job.id } })}
              style={({ pressed }) => [
                styles.jobRow,
                index > 0 && styles.rowBorderTop,
                pressed && styles.rowPressed,
              ]}>
              <View style={styles.jobBody}>
                <Text style={styles.jobNumber}>{job.job_number ?? '—'}</Text>
                <Text style={styles.jobName} numberOfLines={1}>
                  {job.name}
                </Text>
                <Text style={styles.jobMeta}>{when}</Text>
              </View>
              <StatusPill
                stage={labelForJob({
                  stage: job.stage,
                  status: job.status,
                  is_internal: job.is_internal ?? false,
                })}
              />
              <Ionicons name="chevron-forward" size={16} color={colors.inkSoft} />
            </Pressable>
          );
        })
      )}
      {isAdmin ? (
        <Pressable
          onPress={() =>
            router.push({ pathname: '/job-editor', params: { customerId: customer.id } })
          }
          style={({ pressed }) => [
            styles.manageRow,
            styles.rowBorderTop,
            pressed && styles.rowPressed,
          ]}>
          <Ionicons name="add-circle" size={16} color={colors.ocean} />
          <Text style={styles.manageText}>New job for this customer</Text>
        </Pressable>
      ) : null}
    </View>
  );

  const documentsSegment = (
    <>
      <View style={styles.card}>
        <Text style={styles.cardTitle}>Estimates, contracts & invoices</Text>
        {paperwork.length === 0 ? (
          <Text style={styles.emptyText}>
            {isAdmin
              ? 'No documents with a stored PDF yet.'
              : 'Paperwork is only visible to owners and operators.'}
          </Text>
        ) : (
          paperwork.map((row, index) => {
            const job = row.job_id ? jobsById.get(row.job_id) : null;
            const label = row.document_number ?? row.description ?? row.type;
            const stale = row.document_meta?.pdf_state === 'stale';
            return (
              <View key={row.id} style={[styles.docRow, index > 0 && styles.rowBorderTop]}>
                <Pressable
                  onPress={() => void openPaperwork(row.document_path, row.revision)}
                  style={({ pressed }) => [styles.docBody, pressed && styles.pressed]}>
                  <Ionicons name="document-text" size={16} color={colors.ocean} />
                  <View style={styles.docText}>
                    <Text style={styles.docName} numberOfLines={1}>
                      {label}
                      {row.revision && row.revision > 1 ? ` · rev ${row.revision}` : ''}
                    </Text>
                    <Text style={styles.docMeta} numberOfLines={1}>
                      {[
                        job?.job_number,
                        row.occurred_on ? formatShortDate(row.occurred_on) : null,
                        moneyShort(row.amount),
                        stale ? 'PDF out of date' : null,
                      ]
                        .filter(Boolean)
                        .join(' · ')}
                    </Text>
                  </View>
                </Pressable>
                <Pressable
                  onPress={() =>
                    void sharePaperwork(
                      row.id,
                      row.document_path,
                      `${label}.pdf`,
                      row.revision,
                    )
                  }
                  disabled={busyDocId === row.id}
                  hitSlop={6}
                  style={({ pressed }) => [styles.docIconButton, pressed && styles.pressed]}>
                  {busyDocId === row.id ? (
                    <ActivityIndicator size="small" color={colors.ocean} />
                  ) : (
                    <Ionicons name="share-outline" size={14} color={colors.ocean} />
                  )}
                </Pressable>
              </View>
            );
          })
        )}
      </View>

      {isAdmin && insurance !== null ? (
        <View style={styles.card}>
          <Text style={styles.cardTitle}>Insurance</Text>
          {insurance.length === 0 ? (
            <Text style={styles.emptyText}>No insurance certificates on file.</Text>
          ) : (
            insurance.map((doc, index) => {
              const confirming = confirmDeleteDocId === doc.id;
              const busy = busyDocId === doc.id;
              return (
                <View key={doc.id} style={[styles.docRow, index > 0 && styles.rowBorderTop]}>
                  <Pressable
                    onPress={() => void openPaperwork(doc.storage_path, null)}
                    style={({ pressed }) => [styles.docBody, pressed && styles.pressed]}>
                    <Ionicons name="shield-checkmark" size={16} color={colors.ocean} />
                    <View style={styles.docText}>
                      <Text style={styles.docName} numberOfLines={1}>
                        {doc.file_name}
                      </Text>
                      <Text style={styles.docMeta}>
                        {formatShortDate(doc.created_at.slice(0, 10))}
                      </Text>
                    </View>
                  </Pressable>
                  <Pressable
                    onPress={() =>
                      void sharePaperwork(doc.id, doc.storage_path, doc.file_name, null)
                    }
                    disabled={busy}
                    hitSlop={6}
                    style={({ pressed }) => [styles.docIconButton, pressed && styles.pressed]}>
                    {busy && !confirming ? (
                      <ActivityIndicator size="small" color={colors.ocean} />
                    ) : (
                      <Ionicons name="share-outline" size={14} color={colors.ocean} />
                    )}
                  </Pressable>
                  <Pressable
                    onPress={() => void pressDeleteInsurance(doc)}
                    disabled={busy}
                    hitSlop={6}
                    style={({ pressed }) => [
                      styles.docIconButton,
                      confirming && styles.docIconDanger,
                      pressed && styles.pressed,
                    ]}>
                    <Ionicons name="trash" size={14} color={confirming ? colors.white : colors.inkSoft} />
                  </Pressable>
                </View>
              );
            })
          )}
          {confirmDeleteDocId && insurance.some((d) => d.id === confirmDeleteDocId) ? (
            <Text style={styles.confirmHint}>Tap the trash again to delete.</Text>
          ) : null}
          <Pressable
            onPress={() => void uploadInsurance()}
            disabled={uploadingInsurance}
            style={({ pressed }) => [
              styles.manageRow,
              styles.rowBorderTop,
              pressed && styles.rowPressed,
            ]}>
            {uploadingInsurance ? (
              <ActivityIndicator size="small" color={colors.ocean} />
            ) : (
              <Ionicons name="cloud-upload" size={16} color={colors.ocean} />
            )}
            <Text style={styles.manageText}>
              {uploadingInsurance ? 'Uploading…' : 'Upload insurance PDF'}
            </Text>
          </Pressable>
        </View>
      ) : null}
    </>
  );

  const moneySegment = (
    <>
      <View style={styles.card}>
        <Text style={styles.cardTitle}>Totals</Text>
        {summary === null ? (
          <Text style={styles.emptyText}>No money recorded for this customer yet.</Text>
        ) : (
          <View style={styles.tileGrid}>
            {[
              { label: 'Estimated', value: summary.estimated, tone: colors.slateSoft, fg: colors.slateDeep },
              { label: 'Contracted', value: summary.contracted, tone: colors.indigoSoft, fg: colors.indigoDeep },
              { label: 'Invoiced', value: summary.invoiced, tone: colors.skySoft, fg: colors.ocean },
              { label: 'Paid', value: summary.paid, tone: colors.mintSoft, fg: colors.mintDeep },
              {
                label: 'Balance',
                value: summary.balance,
                tone: summary.balance > 0.005 ? colors.coralSoft : colors.mintSoft,
                fg: summary.balance > 0.005 ? colors.coralDeep : colors.mintDeep,
              },
            ].map((tile) => (
              <View key={tile.label} style={[styles.tile, { backgroundColor: tile.tone }]}>
                <Text style={[styles.tileLabel, { color: tile.fg }]}>{tile.label}</Text>
                <Text style={[styles.tileValue, { color: tile.fg }]}>{moneyShort(tile.value)}</Text>
              </View>
            ))}
          </View>
        )}
      </View>

      <View style={styles.card}>
        <Text style={styles.cardTitle}>By project</Text>
        {finance.length === 0 ? (
          <Text style={styles.emptyText}>Nothing recorded yet.</Text>
        ) : (
          [...financeByJob.entries()].map(([jobId, rows], groupIndex) => {
            const job = jobId === 'none' ? null : jobsById.get(jobId);
            const invoiced = rows
              .filter((r) => r.type === 'invoice')
              .reduce((sum, r) => sum + r.amount, 0);
            const paid = rows
              .filter((r) => r.type === 'payment')
              .reduce((sum, r) => sum + r.amount, 0);
            return (
              <View key={jobId} style={[styles.group, groupIndex > 0 && styles.rowBorderTop]}>
                <Text style={styles.groupTitle}>
                  {job ? `${job.job_number ?? '—'} · ${job.name}` : 'Not linked to a project'}
                </Text>
                <Text style={styles.groupMeta}>
                  {moneyShort(invoiced)} invoiced · {moneyShort(paid)} paid ·{' '}
                  {moneyShort(invoiced - paid)} balance
                </Text>
                {rows.map((row) => (
                  <View key={row.id} style={styles.entryRow}>
                    <Text style={styles.entryType}>{row.type}</Text>
                    <Text style={styles.entryDesc} numberOfLines={1}>
                      {row.document_number ?? row.description ?? '—'}
                    </Text>
                    <Text style={styles.entryDate}>
                      {row.occurred_on ? formatShortDate(row.occurred_on) : ''}
                    </Text>
                    <Text style={styles.entryAmount}>{money(row.amount)}</Text>
                  </View>
                ))}
              </View>
            );
          })
        )}
      </View>
    </>
  );

  const commsSegment = (
    <>
      <View style={styles.card}>
        <Text style={styles.cardTitle}>Texting and calling</Text>
        <Text style={styles.bodyText}>
          Texting and calling from the DC Solar number aren&apos;t set up yet — see
          docs/TWILIO_SETUP.md. Until the business number and the A2P campaign are approved, use
          your own phone.
        </Text>
        {customer.sms_opt_out_at ? (
          <Text style={styles.warnText}>
            This customer replied STOP on {formatShortDate(customer.sms_opt_out_at.slice(0, 10))} —
            we may not text them.
          </Text>
        ) : null}
      </View>
      {customer.phone ? (
        <View>
          <PhoneActionSheet
            phone={customer.phone}
            phoneE164={customer.phone_e164 ?? null}
            name={customer.name}
            isAdmin={isAdmin}
            optedOut={customer.sms_opt_out_at != null}
          />
        </View>
      ) : (
        <View style={styles.card}>
          <Text style={styles.emptyText}>No phone number on file.</Text>
        </View>
      )}
    </>
  );

  const notesSegment = (
    <>
      {customer.notes ? (
        <View style={[styles.card, styles.pinnedCard]}>
          <View style={styles.noteHead}>
            <Ionicons name="pin" size={14} color={colors.amberDeep} />
            <Text style={styles.noteAuthor}>General notes</Text>
          </View>
          <Text style={styles.bodyText}>{customer.notes}</Text>
          <Text style={styles.hint}>
            This is the customer record&apos;s own notes field — edit it on Overview.
          </Text>
        </View>
      ) : null}

      <View style={styles.card}>
        <Text style={styles.cardTitle}>Add a note</Text>
        <TextInput
          value={noteDraft}
          onChangeText={setNoteDraft}
          placeholder="Gate code, dog, who to call…"
          placeholderTextColor={colors.inkSoft}
          multiline
          style={[styles.input, styles.inputMultiline]}
        />
        <View style={styles.formButtons}>
          <Pressable
            onPress={() => void submitNote()}
            disabled={savingNote || !noteDraft.trim()}
            style={({ pressed }) => [
              styles.saveButton,
              (!noteDraft.trim() || savingNote) && styles.buttonMuted,
              pressed && styles.pressed,
            ]}>
            {savingNote ? (
              <ActivityIndicator color={colors.ink} size="small" />
            ) : (
              <Text style={styles.saveButtonText}>Add note</Text>
            )}
          </Pressable>
        </View>
      </View>

      {!notesAvailable ? (
        <View style={styles.card}>
          <Text style={styles.emptyText}>Notes are unavailable right now.</Text>
        </View>
      ) : notes.length === 0 ? (
        <View style={styles.card}>
          <Text style={styles.emptyText}>No notes yet.</Text>
        </View>
      ) : (
        notes.map((note) => {
          const mine =
            (role?.email ?? '').toLowerCase() === (note.author_email ?? '').toLowerCase();
          const editingThis = editNoteId === note.id;
          return (
            <View key={note.id} style={[styles.card, note.pinned && styles.pinnedCard]}>
              <View style={styles.noteHead}>
                {note.pinned ? <Ionicons name="pin" size={14} color={colors.amberDeep} /> : null}
                <Text style={styles.noteAuthor}>{authorName(note.author_email)}</Text>
                <Text style={styles.noteTime}>{relativeTime(note.created_at)}</Text>
                <View style={styles.noteActions}>
                  {mine || isAdmin ? (
                    <Pressable
                      onPress={() => void togglePin(note)}
                      hitSlop={6}
                      style={({ pressed }) => pressed && styles.pressed}>
                      <Ionicons
                        name={note.pinned ? 'pin' : 'pin-outline'}
                        size={15}
                        color={colors.inkSoft}
                      />
                    </Pressable>
                  ) : null}
                  {mine || isAdmin ? (
                    <Pressable
                      onPress={() => {
                        setEditNoteId(editingThis ? null : note.id);
                        setEditNoteBody(note.body);
                      }}
                      hitSlop={6}
                      style={({ pressed }) => pressed && styles.pressed}>
                      <Ionicons name="pencil" size={15} color={colors.inkSoft} />
                    </Pressable>
                  ) : null}
                  {isAdmin ? (
                    <Pressable
                      onPress={() => void pressDeleteNote(note)}
                      hitSlop={6}
                      style={({ pressed }) => pressed && styles.pressed}>
                      <Ionicons
                        name="trash"
                        size={15}
                        color={confirmDeleteNoteId === note.id ? colors.danger : colors.inkSoft}
                      />
                    </Pressable>
                  ) : null}
                </View>
              </View>
              {editingThis ? (
                <>
                  <TextInput
                    value={editNoteBody}
                    onChangeText={setEditNoteBody}
                    multiline
                    style={[styles.input, styles.inputMultiline]}
                  />
                  <View style={styles.formButtons}>
                    <Pressable
                      onPress={() => setEditNoteId(null)}
                      style={({ pressed }) => [styles.cancelButton, pressed && styles.pressed]}>
                      <Text style={styles.cancelButtonText}>Cancel</Text>
                    </Pressable>
                    <Pressable
                      onPress={() => void saveNoteEdit(note)}
                      style={({ pressed }) => [styles.saveButton, pressed && styles.pressed]}>
                      <Text style={styles.saveButtonText}>Save</Text>
                    </Pressable>
                  </View>
                </>
              ) : (
                <Text style={styles.bodyText}>{note.body}</Text>
              )}
              {confirmDeleteNoteId === note.id ? (
                <Text style={styles.confirmHint}>Tap the trash again to delete.</Text>
              ) : null}
            </View>
          );
        })
      )}
    </>
  );

  return (
    <>
      <Stack.Screen options={{ title: customer.name }} />
      <ScrollView
        style={styles.screen}
        contentContainerStyle={styles.container}
        keyboardShouldPersistTaps="handled"
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.ocean} />
        }>
        <View style={styles.segmentRow}>
          {segments.map((option) => {
            const active = option.key === segment;
            return (
              <Pressable
                key={option.key}
                onPress={() => setSegment(option.key)}
                style={({ pressed }) => [
                  styles.segment,
                  active && styles.segmentActive,
                  pressed && styles.pressed,
                ]}>
                <Text style={[styles.segmentText, active && styles.segmentTextActive]}>
                  {option.label}
                </Text>
              </Pressable>
            );
          })}
        </View>

        {segment === 'overview' ? overview : null}
        {segment === 'jobs' ? jobsSegment : null}
        {segment === 'documents' ? documentsSegment : null}
        {segment === 'money' ? moneySegment : null}
        {segment === 'comms' ? commsSegment : null}
        {segment === 'notes' ? notesSegment : null}

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
  screen: { flex: 1, backgroundColor: colors.cream },
  centerScreen: { alignItems: 'center', justifyContent: 'center' },
  container: { padding: spacing.lg, gap: spacing.md, paddingBottom: spacing.xxl },
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
  promptTitle: { color: colors.ink, fontSize: 17, fontWeight: '800', textAlign: 'center' },
  promptText: { color: colors.inkSoft, fontSize: 14, fontWeight: '600', textAlign: 'center' },

  // Segmented control: a pill track with the active segment filled, matching
  // the Sales tab so the app has one segmented control, not two.
  segmentRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    backgroundColor: colors.tan,
    borderRadius: radii.pill,
    padding: 3,
  },
  segment: {
    flexGrow: 1,
    flexBasis: 0,
    minWidth: 74,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radii.pill,
    paddingVertical: spacing.sm - 2,
  },
  segmentActive: { backgroundColor: colors.white, ...shadows.card },
  segmentText: { color: colors.inkSoft, fontSize: 12, fontWeight: '800' },
  segmentTextActive: { color: colors.ink },

  card: {
    backgroundColor: colors.white,
    borderRadius: radii.md,
    padding: spacing.md,
    gap: spacing.xs,
    ...shadows.card,
  },
  pinnedCard: { borderLeftWidth: 3, borderLeftColor: colors.amber },
  noticeCard: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    backgroundColor: colors.slateSoft,
    borderRadius: radii.md,
    padding: spacing.md,
  },
  noticeText: { flex: 1, color: colors.slateDeep, fontSize: 13, fontWeight: '600' },
  cardTitle: { color: colors.ink, fontSize: 16, fontWeight: '800' },
  bodyText: { color: colors.ink, fontSize: 14, fontWeight: '500' },
  warnText: { color: colors.danger, fontSize: 13, fontWeight: '700' },
  emptyText: { color: colors.inkSoft, fontSize: 14, fontWeight: '600' },
  hint: { color: colors.inkSoft, fontSize: 12, fontWeight: '600' },

  identityRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  avatarBusy: {
    width: 72,
    height: 72,
    borderRadius: 36,
    backgroundColor: colors.skySoft,
    alignItems: 'center',
    justifyContent: 'center',
  },
  identityBody: { flex: 1, gap: 2 },
  identityName: { color: colors.ink, fontSize: 20, fontWeight: '800' },
  identityMeta: { color: colors.inkSoft, fontSize: 13, fontWeight: '600' },

  rowBorderTop: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.tan },
  rowPressed: { backgroundColor: colors.skySoft },
  pressed: { opacity: 0.7 },
  iconWrap: {
    width: 32,
    height: 32,
    borderRadius: radii.sm,
    backgroundColor: colors.skySoft,
    alignItems: 'center',
    justifyContent: 'center',
  },
  contactRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingVertical: spacing.sm,
  },
  contactBody: { flex: 1, gap: 2 },
  contactValue: { color: colors.ink, fontSize: 15, fontWeight: '600' },
  sheetWrap: { paddingTop: spacing.sm },
  notesBlock: { paddingTop: spacing.sm, gap: 2 },

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
  inputMultiline: { minHeight: 64, textAlignVertical: 'top' },
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
  cancelButtonText: { color: colors.inkSoft, fontSize: 14, fontWeight: '700' },
  saveButton: {
    backgroundColor: colors.sun,
    borderRadius: radii.pill,
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.lg,
    alignItems: 'center',
    justifyContent: 'center',
  },
  saveButtonText: { color: colors.ink, fontSize: 14, fontWeight: '800' },
  secondaryButton: {
    backgroundColor: colors.skySoft,
    borderRadius: radii.pill,
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.lg,
    alignItems: 'center',
    alignSelf: 'flex-start',
    marginTop: spacing.xs,
  },
  secondaryButtonText: { color: colors.ocean, fontSize: 14, fontWeight: '800' },
  buttonMuted: { opacity: 0.5 },

  manageRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingVertical: spacing.sm,
  },
  manageText: { color: colors.ocean, fontSize: 14, fontWeight: '700' },
  manageTextDanger: { color: colors.danger },
  mergeArea: { gap: spacing.xs, paddingTop: spacing.xs },
  mergeRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingVertical: spacing.sm,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.tan,
  },
  mergeRowConfirm: { backgroundColor: colors.coralSoft },
  mergeBody: { flex: 1, gap: 2 },
  mergeName: { color: colors.ink, fontSize: 14, fontWeight: '700' },
  mergeMeta: { color: colors.inkSoft, fontSize: 12, fontWeight: '600' },
  mergeAction: { color: colors.ocean, fontSize: 13, fontWeight: '800' },

  jobRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingVertical: spacing.sm,
  },
  jobBody: { flex: 1, gap: 2 },
  jobNumber: {
    color: colors.inkSoft,
    fontSize: 11,
    fontWeight: '800',
    letterSpacing: 0.5,
  },
  jobName: { color: colors.ink, fontSize: 15, fontWeight: '700' },
  jobMeta: { color: colors.inkSoft, fontSize: 12, fontWeight: '600' },

  docRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, paddingVertical: spacing.xs },
  docBody: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  docText: { flex: 1, gap: 2 },
  docName: { color: colors.ink, fontSize: 14, fontWeight: '700' },
  docMeta: { color: colors.inkSoft, fontSize: 12, fontWeight: '600' },
  docIconButton: {
    width: 26,
    height: 26,
    borderRadius: radii.sm,
    backgroundColor: colors.skySoft,
    alignItems: 'center',
    justifyContent: 'center',
  },
  docIconDanger: { backgroundColor: colors.danger },
  confirmHint: { color: colors.danger, fontSize: 12, fontWeight: '700', textAlign: 'right' },

  tileGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm, marginTop: spacing.xs },
  tile: {
    flexGrow: 1,
    flexBasis: '30%',
    minWidth: 96,
    borderRadius: radii.sm,
    padding: spacing.sm,
    gap: 2,
  },
  tileLabel: { fontSize: 11, fontWeight: '800', textTransform: 'uppercase', letterSpacing: 0.5 },
  tileValue: { fontSize: 17, fontWeight: '800' },

  group: { paddingTop: spacing.sm, gap: 2 },
  groupTitle: { color: colors.ink, fontSize: 14, fontWeight: '800' },
  groupMeta: { color: colors.inkSoft, fontSize: 12, fontWeight: '600', marginBottom: spacing.xs },
  entryRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, paddingVertical: 2 },
  entryType: {
    color: colors.inkSoft,
    fontSize: 11,
    fontWeight: '800',
    textTransform: 'uppercase',
    width: 62,
  },
  entryDesc: { flex: 1, color: colors.ink, fontSize: 13, fontWeight: '600' },
  entryDate: { color: colors.inkSoft, fontSize: 12, fontWeight: '600' },
  entryAmount: { color: colors.ink, fontSize: 13, fontWeight: '800' },

  noteHead: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs },
  noteAuthor: { color: colors.ink, fontSize: 13, fontWeight: '800' },
  noteTime: { color: colors.inkSoft, fontSize: 12, fontWeight: '600' },
  noteActions: { flex: 1, flexDirection: 'row', justifyContent: 'flex-end', gap: spacing.sm },

  statusText: { fontSize: 13, fontWeight: '600', textAlign: 'center' },
  statusError: { color: colors.danger },
  statusSuccess: { color: colors.ocean },
});
