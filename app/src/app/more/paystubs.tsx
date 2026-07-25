import Ionicons from '@expo/vector-icons/Ionicons';
import * as DocumentPicker from 'expo-document-picker';
import { Stack } from 'expo-router';
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';

import { colors, radii, shadows, spacing } from '@/constants/theme';
import { formatShortDate } from '@/lib/dates';
import { viewDocument } from '@/lib/pdf';
import {
  fetchEmployees,
  fetchMyEmployeeId,
  fetchPaystubs,
  getPaystubUrl,
  uploadPaystub,
  type EmployeeDocument,
  type EmployeeLite,
} from '@/lib/paystubs';
import { useRole } from '@/lib/role';
import { supabase } from '@/lib/supabase';

function formatBytes(bytes: number | null): string {
  if (bytes == null || bytes <= 0) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Show success/error feedback: Alert on native, inline status text on web. */
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

function PaystubRow({
  doc,
  isFirst,
  onPress,
}: {
  doc: EmployeeDocument;
  isFirst: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [
        styles.row,
        !isFirst && styles.rowBorderTop,
        pressed && styles.rowPressed,
      ]}>
      <View style={styles.iconWrap}>
        <Ionicons name="cash" size={18} color={colors.ocean} />
      </View>
      <View style={styles.rowBody}>
        <Text style={styles.rowValue} numberOfLines={1}>
          {doc.period_label ?? doc.file_name}
        </Text>
        <Text style={styles.rowMeta} numberOfLines={1}>
          {doc.file_name} · {formatShortDate(doc.created_at?.slice(0, 10) ?? null)}
          {formatBytes(doc.size_bytes) ? ` · ${formatBytes(doc.size_bytes)}` : ''}
        </Text>
      </View>
      <Ionicons name="chevron-forward" size={18} color={colors.inkSoft} />
    </Pressable>
  );
}

export default function PaystubsScreen() {
  const role = useRole();
  const [signedIn, setSignedIn] = useState<boolean | null>(null);
  const [email, setEmail] = useState<string | null>(null);

  // My paystubs
  const [myState, setMyState] = useState<'loading' | 'ok' | 'unavailable'>('loading');
  const [myPaystubs, setMyPaystubs] = useState<EmployeeDocument[]>([]);

  // Admin: all paystubs + upload
  const [employees, setEmployees] = useState<EmployeeLite[]>([]);
  const [allState, setAllState] = useState<'loading' | 'ok' | 'unavailable'>('loading');
  const [allPaystubs, setAllPaystubs] = useState<EmployeeDocument[]>([]);
  const [selectedEmployee, setSelectedEmployee] = useState<string | null>(null);
  const [periodLabel, setPeriodLabel] = useState('');
  const [uploading, setUploading] = useState(false);
  const [status, setStatus] = useState<{ kind: 'success' | 'error'; message: string } | null>(
    null,
  );

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

  const loadMine = useCallback(async () => {
    if (!email) {
      setMyPaystubs([]);
      setMyState('ok');
      return;
    }
    const employeeId = await fetchMyEmployeeId(email);
    if (!employeeId) {
      setMyPaystubs([]);
      setMyState('unavailable');
      return;
    }
    const result = await fetchPaystubs(employeeId);
    if (result.status === 'ok') {
      setMyPaystubs(result.paystubs);
      setMyState('ok');
    } else {
      setMyPaystubs([]);
      setMyState('unavailable');
    }
  }, [email]);

  useEffect(() => {
    if (signedIn === null) return;
    setMyState('loading');
    loadMine();
  }, [signedIn, loadMine]);

  const loadAll = useCallback(async () => {
    const [list, result] = await Promise.all([fetchEmployees(), fetchPaystubs()]);
    setEmployees(list);
    if (result.status === 'ok') {
      setAllPaystubs(result.paystubs);
      setAllState('ok');
    } else {
      setAllPaystubs([]);
      setAllState('unavailable');
    }
  }, []);

  useEffect(() => {
    if (role?.isAdmin) loadAll();
  }, [role?.isAdmin, loadAll]);

  const employeeLabel = useCallback(
    (employeeId: string) => {
      const employee = employees.find((e) => e.id === employeeId);
      return employee ? (employee.display_name ?? employee.email) : 'Unknown employee';
    },
    [employees],
  );

  const grouped = useMemo(() => {
    const groups: { employeeId: string; docs: EmployeeDocument[] }[] = [];
    for (const doc of allPaystubs) {
      const group = groups.find((g) => g.employeeId === doc.employee_id);
      if (group) group.docs.push(doc);
      else groups.push({ employeeId: doc.employee_id, docs: [doc] });
    }
    return groups;
  }, [allPaystubs]);

  const openPaystub = async (doc: EmployeeDocument) => {
    const url = await getPaystubUrl(doc.file_path);
    if (!url || !(await viewDocument(url))) {
      notify(setStatus, 'error', 'Could not open paystub', 'Please try again.');
    }
  };

  const pickAndUpload = async () => {
    setStatus(null);
    if (!selectedEmployee) {
      notify(setStatus, 'error', 'Pick an employee', 'Choose who this paystub is for.');
      return;
    }
    const label = periodLabel.trim();
    if (!label) {
      notify(setStatus, 'error', 'Add a period', 'Enter a pay period like "Jul 1–15, 2026".');
      return;
    }
    try {
      const result = await DocumentPicker.getDocumentAsync({
        type: 'application/pdf',
        copyToCacheDirectory: true,
        multiple: false,
      });
      if (result.canceled || !result.assets?.length) return;
      const asset = result.assets[0];

      setUploading(true);
      const upload = await uploadPaystub({
        employeeId: selectedEmployee,
        periodLabel: label,
        fileName: asset.name ?? 'paystub.pdf',
        uri: asset.uri,
        contentType: asset.mimeType ?? 'application/pdf',
        uploadedBy: role?.email ?? email,
      });
      if (upload.ok) {
        setAllPaystubs((prev) => [upload.paystub, ...prev]);
        setAllState('ok');
        if (upload.paystub.employee_id && email) {
          // Refresh "my paystubs" in case the admin uploaded their own stub.
          loadMine();
        }
        setPeriodLabel('');
        notify(setStatus, 'success', 'Uploaded', `Paystub for ${label} was added.`);
      } else {
        notify(setStatus, 'error', 'Upload failed', upload.message);
      }
    } catch {
      notify(setStatus, 'error', 'Upload failed', 'Something went wrong. Please try again.');
    } finally {
      setUploading(false);
    }
  };

  return (
    <>
      <Stack.Screen options={{ title: 'Paystubs' }} />
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
            <Text style={styles.placeholderText}>Sign in to view your paystubs.</Text>
          </View>
        ) : (
          <>
            <Text style={styles.sectionTitle}>My paystubs</Text>
            {myState === 'loading' ? (
              <View style={styles.placeholderCard}>
                <ActivityIndicator color={colors.ocean} />
              </View>
            ) : myState === 'unavailable' ? (
              <View style={styles.placeholderCard}>
                <Ionicons name="cloud-offline" size={22} color={colors.inkSoft} />
                <Text style={styles.placeholderText}>Paystubs not available right now</Text>
              </View>
            ) : myPaystubs.length === 0 ? (
              <View style={styles.placeholderCard}>
                <Ionicons name="cash" size={22} color={colors.inkSoft} />
                <Text style={styles.placeholderText}>No paystubs yet</Text>
              </View>
            ) : (
              <View style={styles.card}>
                {myPaystubs.map((doc, index) => (
                  <PaystubRow
                    key={doc.id}
                    doc={doc}
                    isFirst={index === 0}
                    onPress={() => openPaystub(doc)}
                  />
                ))}
              </View>
            )}

            {role?.isAdmin ? (
              <>
                <Text style={styles.sectionTitle}>Upload paystub</Text>
                <View style={styles.formCard}>
                  <Text style={styles.fieldLabel}>Employee</Text>
                  <View style={styles.chipRow}>
                    {employees.length === 0 ? (
                      <Text style={styles.placeholderText}>No employees found</Text>
                    ) : (
                      employees.map((employee) => (
                        <Pressable
                          key={employee.id}
                          onPress={() => setSelectedEmployee(employee.id)}
                          style={[
                            styles.chip,
                            selectedEmployee === employee.id && styles.chipSelected,
                          ]}>
                          <Text
                            style={[
                              styles.chipText,
                              selectedEmployee === employee.id && styles.chipTextSelected,
                            ]}>
                            {employee.display_name ?? employee.email}
                          </Text>
                        </Pressable>
                      ))
                    )}
                  </View>
                  <Text style={styles.fieldLabel}>Pay period</Text>
                  <TextInput
                    value={periodLabel}
                    onChangeText={setPeriodLabel}
                    placeholder='e.g. "Jul 1–15, 2026"'
                    placeholderTextColor={colors.inkSoft}
                    style={styles.input}
                  />
                  <Pressable
                    onPress={pickAndUpload}
                    disabled={uploading}
                    style={({ pressed }) => [
                      styles.uploadButton,
                      (pressed || uploading) && styles.pressed,
                    ]}>
                    {uploading ? (
                      <ActivityIndicator color={colors.ink} />
                    ) : (
                      <Ionicons name="cloud-upload" size={18} color={colors.ink} />
                    )}
                    <Text style={styles.uploadButtonText}>
                      {uploading ? 'Uploading…' : 'Pick PDF & upload'}
                    </Text>
                  </Pressable>
                </View>

                <Text style={styles.sectionTitle}>All paystubs</Text>
                {allState === 'loading' ? (
                  <View style={styles.placeholderCard}>
                    <ActivityIndicator color={colors.ocean} />
                  </View>
                ) : allState === 'unavailable' ? (
                  <View style={styles.placeholderCard}>
                    <Ionicons name="cloud-offline" size={22} color={colors.inkSoft} />
                    <Text style={styles.placeholderText}>Paystubs not available right now</Text>
                  </View>
                ) : grouped.length === 0 ? (
                  <View style={styles.placeholderCard}>
                    <Ionicons name="cash" size={22} color={colors.inkSoft} />
                    <Text style={styles.placeholderText}>No paystubs uploaded yet</Text>
                  </View>
                ) : (
                  grouped.map((group) => (
                    <View key={group.employeeId} style={styles.groupBlock}>
                      <Text style={styles.groupTitle}>{employeeLabel(group.employeeId)}</Text>
                      <View style={styles.card}>
                        {group.docs.map((doc, index) => (
                          <PaystubRow
                            key={doc.id}
                            doc={doc}
                            isFirst={index === 0}
                            onPress={() => openPaystub(doc)}
                          />
                        ))}
                      </View>
                    </View>
                  ))
                )}
              </>
            ) : null}
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
  rowPressed: {
    backgroundColor: colors.skySoft,
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
  formCard: {
    backgroundColor: colors.white,
    borderRadius: radii.md,
    padding: spacing.md,
    gap: spacing.sm,
    ...shadows.card,
  },
  fieldLabel: {
    color: colors.inkSoft,
    fontSize: 12,
    fontWeight: '700',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  chipRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.sm,
  },
  chip: {
    backgroundColor: colors.white,
    borderRadius: radii.pill,
    borderWidth: 1,
    borderColor: colors.tan,
    paddingHorizontal: spacing.sm + 2,
    paddingVertical: spacing.xs,
  },
  chipSelected: {
    backgroundColor: colors.sunLight,
    borderColor: colors.sun,
  },
  chipText: {
    color: colors.inkSoft,
    fontSize: 12,
    fontWeight: '700',
  },
  chipTextSelected: {
    color: colors.ink,
  },
  input: {
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
  uploadButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.sm,
    backgroundColor: colors.sun,
    borderRadius: radii.pill,
    paddingVertical: spacing.md - 2,
    paddingHorizontal: spacing.lg,
    marginTop: spacing.xs,
  },
  uploadButtonText: {
    color: colors.ink,
    fontSize: 15,
    fontWeight: '800',
  },
  pressed: {
    opacity: 0.7,
  },
  groupBlock: {
    gap: spacing.sm,
  },
  groupTitle: {
    color: colors.inkSoft,
    fontSize: 13,
    fontWeight: '800',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
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
