import * as DocumentPicker from 'expo-document-picker';
import { Stack } from 'expo-router';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Alert, Platform, StyleSheet, TextInput, View } from 'react-native';

import {
  AppText,
  Button,
  Card,
  Chip,
  EmptyState,
  FadeInUp,
  ListRow,
  Screen,
  SectionHeader,
  SkeletonList,
} from '@/components/ui';
import { colors, radii, spacing } from '@/constants/theme';
import { formatShortDate } from '@/lib/dates';
import { haptics } from '@/lib/haptics';
import {
  fetchEmployees,
  fetchMyEmployeeId,
  fetchPaystubs,
  getPaystubUrl,
  uploadPaystub,
  type EmployeeDocument,
  type EmployeeLite,
} from '@/lib/paystubs';
import { viewDocument } from '@/lib/pdf';
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
    <ListRow
      icon="cash"
      title={doc.period_label ?? doc.file_name}
      subtitle={`${doc.file_name} · ${formatShortDate(doc.created_at?.slice(0, 10) ?? null)}${
        formatBytes(doc.size_bytes) ? ` · ${formatBytes(doc.size_bytes)}` : ''
      }`}
      onPress={onPress}
      style={!isFirst ? styles.rowBorderTop : undefined}
    />
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
        haptics.success();
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
      <Screen edges={[]}>
        {signedIn === null ? (
          <SkeletonList count={3} height={64} />
        ) : !signedIn ? (
          <Card>
            <EmptyState
              icon="lock-closed"
              title="Sign in to view your paystubs."
              body="Paystubs are tied to your employee record, so the app has to know who you are."
            />
          </Card>
        ) : (
          <>
            <View style={styles.section}>
              <SectionHeader title="My paystubs" icon="cash-outline" />
              {myState === 'loading' ? (
                <SkeletonList count={3} height={64} />
              ) : myState === 'unavailable' ? (
                <Card>
                  <EmptyState
                    icon="cloud-offline"
                    title="Paystubs not available right now"
                    body="Your stubs could not be loaded. Try again once you are back on a signal."
                  />
                </Card>
              ) : myPaystubs.length === 0 ? (
                <Card>
                  <EmptyState
                    icon="cash"
                    title="No paystubs yet"
                    body="The office uploads these each pay period. They show up here as soon as they do."
                  />
                </Card>
              ) : (
                <Card padded={false}>
                  {myPaystubs.map((doc, index) => (
                    <FadeInUp key={doc.id} index={index}>
                      <PaystubRow
                        doc={doc}
                        isFirst={index === 0}
                        onPress={() => openPaystub(doc)}
                      />
                    </FadeInUp>
                  ))}
                </Card>
              )}
            </View>

            {role?.isAdmin ? (
              <>
                <View style={styles.section}>
                  <SectionHeader title="Upload paystub" icon="cloud-upload-outline" />
                  <Card style={styles.formCard}>
                    <AppText variant="section" color={colors.textMuted}>
                      Employee
                    </AppText>
                    <View style={styles.chipRow}>
                      {employees.length === 0 ? (
                        <AppText variant="caption" color={colors.textMuted}>
                          No employees found
                        </AppText>
                      ) : (
                        employees.map((employee) => (
                          <Chip
                            key={employee.id}
                            label={employee.display_name ?? employee.email}
                            tone="sun"
                            selected={selectedEmployee === employee.id}
                            onPress={() => setSelectedEmployee(employee.id)}
                          />
                        ))
                      )}
                    </View>
                    <AppText variant="section" color={colors.textMuted}>
                      Pay period
                    </AppText>
                    <TextInput
                      value={periodLabel}
                      onChangeText={setPeriodLabel}
                      placeholder='e.g. "Jul 1–15, 2026"'
                      placeholderTextColor={colors.textMuted}
                      style={styles.input}
                    />
                    <Button
                      label={uploading ? 'Uploading…' : 'Pick PDF & upload'}
                      icon="cloud-upload"
                      size="lg"
                      fullWidth
                      loading={uploading}
                      onPress={pickAndUpload}
                      style={styles.uploadButton}
                    />
                  </Card>
                </View>

                <View style={styles.section}>
                  <SectionHeader title="All paystubs" icon="folder-open-outline" />
                  {allState === 'loading' ? (
                    <SkeletonList count={3} height={64} />
                  ) : allState === 'unavailable' ? (
                    <Card>
                      <EmptyState
                        icon="cloud-offline"
                        title="Paystubs not available right now"
                        body="The list could not be loaded. Try again once you are back on a signal."
                      />
                    </Card>
                  ) : grouped.length === 0 ? (
                    <Card>
                      <EmptyState
                        icon="cash"
                        title="No paystubs uploaded yet"
                        body="Upload the first PDF above and it appears here, grouped by employee."
                      />
                    </Card>
                  ) : (
                    <View style={styles.groups}>
                      {grouped.map((group, groupIndex) => (
                        <FadeInUp key={group.employeeId} index={groupIndex}>
                          <View style={styles.groupBlock}>
                            <SectionHeader title={employeeLabel(group.employeeId)} />
                            <Card padded={false}>
                              {group.docs.map((doc, index) => (
                                <PaystubRow
                                  key={doc.id}
                                  doc={doc}
                                  isFirst={index === 0}
                                  onPress={() => openPaystub(doc)}
                                />
                              ))}
                            </Card>
                          </View>
                        </FadeInUp>
                      ))}
                    </View>
                  )}
                </View>
              </>
            ) : null}
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
  rowBorderTop: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
  },
  formCard: {
    gap: spacing.sm,
  },
  chipRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.sm,
  },
  input: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radii.sm,
    paddingHorizontal: spacing.sm + 4,
    paddingVertical: spacing.xs + 4,
    color: colors.textPrimary,
    fontSize: 14,
    backgroundColor: colors.surfaceSunk,
  },
  uploadButton: {
    marginTop: spacing.xs,
  },
  groups: {
    gap: spacing.md,
  },
  groupBlock: {
    gap: spacing.xs,
  },
});
