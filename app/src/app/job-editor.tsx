import Ionicons from '@expo/vector-icons/Ionicons';
import { Stack, router, useLocalSearchParams } from 'expo-router';
import { useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';

import { colors, radii, shadows, spacing } from '@/constants/theme';
import { fetchJob } from '@/lib/data';
import {
  createCustomer,
  createJob,
  fetchCustomers,
  nextJobNumber,
  updateJob,
  type JobEditableFields,
  type JobWithPM,
} from '@/lib/jobs';
import { todayISO } from '@/lib/dates';
import { type Customer } from '@/lib/mockData';
import { getRole, type RoleInfo } from '@/lib/role';
import { STAGES, stageOrDefault, statusForStage, type Stage } from '@/lib/stages';
import { isValidISODate } from '@/lib/time';

/**
 * Admin-only job editor. With a `jobId` param it edits that job; without
 * one it creates a new job with the next auto-assigned DC-# moniker
 * (recomputed from the live jobs table right before insert, so numbering
 * stays in sync with the dcsolarkc.com ops console).
 */
export default function JobEditorScreen() {
  const params = useLocalSearchParams<{ jobId?: string }>();
  const jobId = typeof params.jobId === 'string' && params.jobId.length > 0 ? params.jobId : null;
  const isEdit = jobId != null;

  const [role, setRole] = useState<RoleInfo | null | 'loading'>('loading');
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);

  const [jobNumber, setJobNumber] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [stage, setStage] = useState<Stage>('Pending Estimate');
  const [completedOn, setCompletedOn] = useState('');
  const [address, setAddress] = useState('');
  const [customerId, setCustomerId] = useState<string | null>(null);
  const [projectManager, setProjectManager] = useState('');
  const [pmPhone, setPmPhone] = useState('');

  const [customers, setCustomers] = useState<Customer[]>([]);
  const [customerSearch, setCustomerSearch] = useState('');

  // Inline "new customer" mini-form
  const [showNewCustomer, setShowNewCustomer] = useState(false);
  const [ncName, setNcName] = useState('');
  const [ncPhone, setNcPhone] = useState('');
  const [ncEmail, setNcEmail] = useState('');
  const [ncAddress, setNcAddress] = useState('');
  const [ncSaving, setNcSaving] = useState(false);
  const [ncError, setNcError] = useState<string | null>(null);

  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [warning, setWarning] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    getRole().then((info) => {
      if (!cancelled) setRole(info);
    });
    fetchCustomers().then((rows) => {
      if (!cancelled) setCustomers(rows);
    });

    if (jobId) {
      fetchJob(jobId).then((result) => {
        if (cancelled) return;
        if (!result || result.id.startsWith('mock-')) {
          setNotFound(true);
          setLoading(false);
          return;
        }
        const job = result as JobWithPM;
        setJobNumber(job.job_number);
        setName(job.name);
        setDescription(job.description ?? '');
        setStage(stageOrDefault(job.stage, job.status));
        setCompletedOn(job.completed_on ?? '');
        setAddress(job.address ?? '');
        setCustomerId(job.customer_id);
        setProjectManager(job.project_manager ?? '');
        setPmPhone(job.project_manager_phone ?? '');
        setLoading(false);
      });
    } else {
      // Display-only preview; createJob recomputes right before insert.
      nextJobNumber().then((num) => {
        if (cancelled) return;
        setJobNumber(num);
        setLoading(false);
      });
    }
    return () => {
      cancelled = true;
    };
  }, [jobId]);

  const filteredCustomers = useMemo(() => {
    const query = customerSearch.trim().toLowerCase();
    if (!query) return customers;
    return customers.filter((c) => c.name.toLowerCase().includes(query));
  }, [customers, customerSearch]);

  const selectedCustomer = customers.find((c) => c.id === customerId) ?? null;

  const resetNewCustomerForm = () => {
    setShowNewCustomer(false);
    setNcName('');
    setNcPhone('');
    setNcEmail('');
    setNcAddress('');
    setNcSaving(false);
    setNcError(null);
  };

  const addNewCustomer = async () => {
    setNcError(null);
    if (!ncName.trim()) {
      setNcError('Give the customer a name.');
      return;
    }
    setNcSaving(true);
    const result = await createCustomer({
      name: ncName.trim(),
      phone: ncPhone.trim() || null,
      email: ncEmail.trim() || null,
      address: ncAddress.trim() || null,
    });
    if (!result.ok) {
      setNcSaving(false);
      setNcError(result.message);
      return;
    }
    // Refresh the list; if the refetch fails, at least show the new row.
    const rows = await fetchCustomers();
    if (rows.length > 0) {
      setCustomers(rows);
    } else {
      setCustomers((prev) => [...prev, result.customer]);
    }
    setCustomerId(result.customer.id);
    setCustomerSearch('');
    resetNewCustomerForm();
  };

  const save = async () => {
    setError(null);
    setWarning(null);
    if (!name.trim()) {
      setError('Give the project a name.');
      return;
    }

    const completedDate = completedOn.trim();
    if (stage === 'Complete' && completedDate !== '' && !isValidISODate(completedDate)) {
      setError('Enter the completed date as YYYY-MM-DD (e.g. 2026-07-27).');
      return;
    }

    const fields: JobEditableFields = {
      name: name.trim(),
      description: description.trim() || null,
      stage,
      status: statusForStage(stage),
      // Auto-stamp today when marking Complete without a date; clear the
      // date whenever the job moves back out of Complete.
      completed_on:
        stage === 'Complete' ? (completedDate !== '' ? completedDate : todayISO()) : null,
      address: address.trim() || null,
      customer_id: customerId,
      project_manager: projectManager.trim() || null,
      project_manager_phone: pmPhone.trim() || null,
    };

    setSaving(true);
    if (isEdit) {
      const result = await updateJob(jobId, fields);
      setSaving(false);
      if (!result.ok) {
        setError(result.message);
        return;
      }
      if (result.warning) {
        setWarning(result.warning);
        setTimeout(() => router.back(), 1600);
        return;
      }
      router.back();
    } else {
      const result = await createJob(fields);
      setSaving(false);
      if (!result.ok) {
        setError(result.message);
        return;
      }
      if (result.warning) setWarning(result.warning);
      router.replace({ pathname: '/job/[id]', params: { id: result.id } });
    }
  };

  const screenTitle = isEdit ? 'Edit project' : 'New project';

  if (role === 'loading' || loading) {
    return (
      <>
        <Stack.Screen options={{ title: screenTitle }} />
        <View style={styles.center}>
          <ActivityIndicator color={colors.ocean} />
        </View>
      </>
    );
  }

  if (!role || !role.isAdmin) {
    return (
      <>
        <Stack.Screen options={{ title: screenTitle }} />
        <View style={styles.center}>
          <Ionicons name="lock-closed" size={28} color={colors.inkSoft} />
          <Text style={styles.blockText}>
            Editing projects is only available to admins. Please sign in with an admin account.
          </Text>
        </View>
      </>
    );
  }

  if (notFound) {
    return (
      <>
        <Stack.Screen options={{ title: screenTitle }} />
        <View style={styles.center}>
          <Text style={styles.blockText}>Job not found.</Text>
        </View>
      </>
    );
  }

  return (
    <>
      <Stack.Screen options={{ title: screenTitle }} />
      <ScrollView
        style={styles.safe}
        contentContainerStyle={styles.container}
        keyboardShouldPersistTaps="handled">
        <View style={styles.headerCard}>
          <Text style={styles.headerLabel}>{isEdit ? 'Project' : 'New project'}</Text>
          <View style={styles.numberChip}>
            <Ionicons name="pricetag" size={14} color={colors.ocean} />
            <Text style={styles.numberChipText}>{jobNumber ?? 'DC-…'}</Text>
          </View>
          {!isEdit ? (
            <Text style={styles.headerHint}>Job number is assigned automatically.</Text>
          ) : null}
        </View>

        <Text style={styles.sectionTitle}>Details</Text>
        <View style={styles.card}>
          <Text style={styles.fieldLabel}>Name</Text>
          <TextInput
            style={styles.input}
            value={name}
            onChangeText={setName}
            placeholder="e.g. Install 24 modules"
            placeholderTextColor={colors.inkSoft}
          />
          <Text style={styles.fieldLabel}>Description</Text>
          <TextInput
            style={[styles.input, styles.multiline]}
            value={description}
            onChangeText={setDescription}
            placeholder="Scope of work, notes for the crew…"
            placeholderTextColor={colors.inkSoft}
            multiline
          />
          <Text style={styles.fieldLabel}>Stage</Text>
          <View style={styles.chipRow}>
            {STAGES.map((s) => {
              const selected = stage === s;
              return (
                <Pressable
                  key={s}
                  onPress={() => setStage(s)}
                  style={[styles.chip, selected && styles.chipSelected]}>
                  <Text style={[styles.chipText, selected && styles.chipTextSelected]}>{s}</Text>
                </Pressable>
              );
            })}
          </View>
          {stage === 'Complete' ? (
            <>
              <Text style={styles.fieldLabel}>Completed date (YYYY-MM-DD)</Text>
              <TextInput
                style={styles.input}
                value={completedOn}
                onChangeText={setCompletedOn}
                placeholder={`Leave blank for today (${todayISO()})`}
                placeholderTextColor={colors.inkSoft}
                autoCapitalize="none"
                autoCorrect={false}
              />
            </>
          ) : null}
          <Text style={styles.fieldLabel}>Address</Text>
          <TextInput
            style={styles.input}
            value={address}
            onChangeText={setAddress}
            placeholder="Street, city, state"
            placeholderTextColor={colors.inkSoft}
          />
        </View>

        <Text style={styles.sectionTitle}>Project manager</Text>
        <View style={styles.card}>
          <Text style={styles.fieldLabel}>Name</Text>
          <TextInput
            style={styles.input}
            value={projectManager}
            onChangeText={setProjectManager}
            placeholder="Who's running this job?"
            placeholderTextColor={colors.inkSoft}
          />
          <Text style={styles.fieldLabel}>Cell number</Text>
          <TextInput
            style={styles.input}
            value={pmPhone}
            onChangeText={setPmPhone}
            placeholder="(913) 555-0100"
            placeholderTextColor={colors.inkSoft}
            keyboardType="phone-pad"
          />
        </View>

        <Text style={styles.sectionTitle}>Customer</Text>
        <View style={styles.card}>
          {customers.length > 4 ? (
            <TextInput
              style={styles.input}
              value={customerSearch}
              onChangeText={setCustomerSearch}
              placeholder="Search customers"
              placeholderTextColor={colors.inkSoft}
            />
          ) : null}
          <Pressable
            onPress={() => setCustomerId(null)}
            style={({ pressed }) => [styles.customerRow, pressed && styles.rowPressed]}>
            <Text style={[styles.customerName, customerId === null && styles.customerSelected]}>
              No customer
            </Text>
            {customerId === null ? (
              <Ionicons name="checkmark-circle" size={20} color={colors.ocean} />
            ) : null}
          </Pressable>
          {filteredCustomers.map((customer) => {
            const selected = customer.id === customerId;
            return (
              <Pressable
                key={customer.id}
                onPress={() => setCustomerId(customer.id)}
                style={({ pressed }) => [
                  styles.customerRow,
                  styles.rowBorderTop,
                  pressed && styles.rowPressed,
                ]}>
                <View style={styles.customerBody}>
                  <Text style={[styles.customerName, selected && styles.customerSelected]}>
                    {customer.name}
                  </Text>
                  {customer.address ? (
                    <Text style={styles.customerAddress} numberOfLines={1}>
                      {customer.address}
                    </Text>
                  ) : null}
                </View>
                {selected ? (
                  <Ionicons name="checkmark-circle" size={20} color={colors.ocean} />
                ) : null}
              </Pressable>
            );
          })}
          {customers.length === 0 ? (
            <Text style={styles.emptyText}>No customers available.</Text>
          ) : filteredCustomers.length === 0 ? (
            <Text style={styles.emptyText}>No customers match "{customerSearch.trim()}".</Text>
          ) : null}
          {selectedCustomer && customerSearch ? (
            <Text style={styles.selectedNote}>Selected: {selectedCustomer.name}</Text>
          ) : null}

          {!showNewCustomer ? (
            <Pressable
              onPress={() => {
                setShowNewCustomer(true);
                setNcError(null);
              }}
              style={({ pressed }) => [
                styles.newCustomerToggle,
                styles.rowBorderTop,
                pressed && styles.rowPressed,
              ]}>
              <Ionicons name="person-add" size={16} color={colors.ocean} />
              <Text style={styles.newCustomerToggleText}>+ New customer</Text>
            </Pressable>
          ) : (
            <View style={[styles.newCustomerForm, styles.rowBorderTop]}>
              <Text style={styles.newCustomerTitle}>New customer</Text>
              <Text style={styles.fieldLabel}>Name</Text>
              <TextInput
                style={styles.input}
                value={ncName}
                onChangeText={setNcName}
                placeholder="Customer name"
                placeholderTextColor={colors.inkSoft}
              />
              <Text style={styles.fieldLabel}>Phone</Text>
              <TextInput
                style={styles.input}
                value={ncPhone}
                onChangeText={setNcPhone}
                placeholder="(913) 555-0100"
                placeholderTextColor={colors.inkSoft}
                keyboardType="phone-pad"
              />
              <Text style={styles.fieldLabel}>Email</Text>
              <TextInput
                style={styles.input}
                value={ncEmail}
                onChangeText={setNcEmail}
                placeholder="name@example.com"
                placeholderTextColor={colors.inkSoft}
                keyboardType="email-address"
                autoCapitalize="none"
              />
              <Text style={styles.fieldLabel}>Address</Text>
              <TextInput
                style={styles.input}
                value={ncAddress}
                onChangeText={setNcAddress}
                placeholder="Street, city, state"
                placeholderTextColor={colors.inkSoft}
              />
              {ncError ? <Text style={styles.errorText}>{ncError}</Text> : null}
              <View style={styles.newCustomerButtons}>
                <Pressable
                  onPress={resetNewCustomerForm}
                  disabled={ncSaving}
                  style={({ pressed }) => [styles.cancelButton, pressed && styles.buttonPressed]}>
                  <Text style={styles.cancelButtonText}>Cancel</Text>
                </Pressable>
                <Pressable
                  onPress={addNewCustomer}
                  disabled={ncSaving}
                  style={({ pressed }) => [
                    styles.addCustomerButton,
                    (pressed || ncSaving) && styles.buttonPressed,
                  ]}>
                  {ncSaving ? (
                    <ActivityIndicator color={colors.ink} size="small" />
                  ) : (
                    <Text style={styles.addCustomerButtonText}>Add customer</Text>
                  )}
                </Pressable>
              </View>
            </View>
          )}
        </View>

        {error ? <Text style={styles.errorText}>{error}</Text> : null}
        {warning ? <Text style={styles.warningText}>{warning}</Text> : null}

        <Pressable
          onPress={save}
          disabled={saving}
          style={({ pressed }) => [
            styles.primaryButton,
            (pressed || saving) && styles.buttonPressed,
          ]}>
          {saving ? (
            <ActivityIndicator color={colors.ink} />
          ) : (
            <Ionicons name={isEdit ? 'save' : 'add-circle'} size={18} color={colors.ink} />
          )}
          <Text style={styles.primaryButtonText}>
            {saving ? 'Saving…' : isEdit ? 'Save changes' : 'Create project'}
          </Text>
        </Pressable>
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
    gap: spacing.md,
  },
  center: {
    flex: 1,
    backgroundColor: colors.cream,
    alignItems: 'center',
    justifyContent: 'center',
    padding: spacing.xl,
    gap: spacing.sm,
  },
  blockText: {
    color: colors.inkSoft,
    fontSize: 15,
    fontWeight: '600',
    textAlign: 'center',
  },
  headerCard: {
    backgroundColor: colors.white,
    borderRadius: radii.md,
    padding: spacing.md,
    gap: spacing.xs,
    ...shadows.card,
  },
  headerLabel: {
    color: colors.inkSoft,
    fontSize: 12,
    fontWeight: '800',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  numberChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    alignSelf: 'flex-start',
    backgroundColor: colors.skySoft,
    borderRadius: radii.pill,
    paddingVertical: spacing.xs + 2,
    paddingHorizontal: spacing.sm + 4,
  },
  numberChipText: {
    color: colors.ocean,
    fontSize: 15,
    fontWeight: '800',
  },
  headerHint: {
    color: colors.inkSoft,
    fontSize: 12,
    fontWeight: '600',
  },
  sectionTitle: {
    color: colors.ink,
    fontSize: 18,
    fontWeight: '700',
    marginTop: spacing.sm,
  },
  card: {
    backgroundColor: colors.white,
    borderRadius: radii.md,
    padding: spacing.md,
    gap: spacing.sm,
    ...shadows.card,
  },
  fieldLabel: {
    color: colors.inkSoft,
    fontSize: 11,
    fontWeight: '800',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginTop: spacing.xs,
  },
  input: {
    backgroundColor: colors.cream,
    borderRadius: radii.sm,
    borderWidth: 1,
    borderColor: colors.tan,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.sm,
    color: colors.ink,
    fontSize: 14,
    fontWeight: '600',
  },
  multiline: {
    minHeight: 72,
    textAlignVertical: 'top',
  },
  chipRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.sm,
  },
  chip: {
    backgroundColor: colors.cream,
    borderWidth: 1,
    borderColor: colors.tan,
    borderRadius: radii.pill,
    paddingVertical: spacing.xs + 2,
    paddingHorizontal: spacing.md,
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
  customerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.sm,
    paddingVertical: spacing.sm + 2,
  },
  rowBorderTop: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.tan,
  },
  rowPressed: {
    backgroundColor: colors.skySoft,
  },
  customerBody: {
    flex: 1,
    gap: 2,
  },
  customerName: {
    color: colors.ink,
    fontSize: 15,
    fontWeight: '600',
  },
  customerSelected: {
    color: colors.ocean,
    fontWeight: '800',
  },
  customerAddress: {
    color: colors.inkSoft,
    fontSize: 12,
    fontWeight: '600',
  },
  emptyText: {
    color: colors.inkSoft,
    fontSize: 13,
    fontWeight: '600',
    paddingVertical: spacing.xs,
  },
  selectedNote: {
    color: colors.ocean,
    fontSize: 12,
    fontWeight: '700',
  },
  newCustomerToggle: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    paddingVertical: spacing.sm + 2,
  },
  newCustomerToggleText: {
    color: colors.ocean,
    fontSize: 14,
    fontWeight: '800',
  },
  newCustomerForm: {
    gap: spacing.sm,
    paddingTop: spacing.sm,
  },
  newCustomerTitle: {
    color: colors.ink,
    fontSize: 15,
    fontWeight: '800',
    marginTop: spacing.xs,
  },
  newCustomerButtons: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    alignItems: 'center',
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
  addCustomerButton: {
    backgroundColor: colors.sun,
    borderRadius: radii.pill,
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.lg,
    alignItems: 'center',
    justifyContent: 'center',
  },
  addCustomerButtonText: {
    color: colors.ink,
    fontSize: 14,
    fontWeight: '800',
  },
  errorText: {
    color: colors.danger,
    fontSize: 13,
    fontWeight: '600',
    textAlign: 'center',
  },
  warningText: {
    color: colors.danger,
    fontSize: 13,
    fontWeight: '600',
    textAlign: 'center',
  },
  primaryButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.sm,
    backgroundColor: colors.sun,
    borderRadius: radii.pill,
    paddingVertical: spacing.md - 2,
    paddingHorizontal: spacing.lg,
    marginTop: spacing.sm,
    alignSelf: 'stretch',
    ...shadows.card,
  },
  buttonPressed: {
    opacity: 0.7,
  },
  primaryButtonText: {
    color: colors.ink,
    fontSize: 15,
    fontWeight: '800',
  },
});
