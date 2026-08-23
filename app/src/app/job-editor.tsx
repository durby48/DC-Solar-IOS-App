import Ionicons from '@expo/vector-icons/Ionicons';
import { Stack, router, useLocalSearchParams } from 'expo-router';
import { useEffect, useMemo, useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { Field } from '@/components/forms/Field';
import {
  AnimatedPressable,
  AppText,
  Button,
  Card,
  Chip,
  EmptyState,
  ListRow,
  Screen,
  SectionHeader,
  SkeletonList,
} from '@/components/ui';
import { colors, spacing } from '@/constants/theme';
import { fetchJob } from '@/lib/data';
import * as haptics from '@/lib/haptics';
import {
  createCustomer,
  createJob,
  deleteJob,
  fetchCustomers,
  JOB_TYPES,
  nextJobNumber,
  parseJobType,
  parseModuleCount,
  updateJob,
  type JobEditableFields,
  type JobType,
  type JobWithPM,
} from '@/lib/jobs';
import { todayISO } from '@/lib/dates';
import { type Customer } from '@/lib/types';
import { getRole, type RoleInfo } from '@/lib/role';
import { STAGES, stageOrDefault, statusForStage, type Stage } from '@/lib/stages';
import { isValidISODate } from '@/lib/time';

/**
 * Admin-only job editor. With a `jobId` param it edits that job; without
 * one it creates a new job with the next auto-assigned DC-# moniker
 * (recomputed from the live jobs table right before insert, so numbering
 * stays in sync with the dcsolarkc.com ops console).
 *
 * A `customerId` param pre-selects that customer in the picker. It is honoured
 * in NEW-JOB MODE ONLY — the CRM's "New job for this customer" button is the
 * one caller — because on an existing job the row's own `customer_id` is the
 * truth and a stray param must never silently reassign it.
 */
export default function JobEditorScreen() {
  const params = useLocalSearchParams<{ jobId?: string; customerId?: string }>();
  const jobId = typeof params.jobId === 'string' && params.jobId.length > 0 ? params.jobId : null;
  const presetCustomerId =
    typeof params.customerId === 'string' && params.customerId.length > 0
      ? params.customerId
      : null;
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
  const [customerId, setCustomerId] = useState<string | null>(isEdit ? null : presetCustomerId);
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
  const [moduleCount, setModuleCount] = useState('');
  const [jobType, setJobType] = useState<JobType>('R&R');
  const [critterPanels, setCritterPanels] = useState('');
  const [hasCritterGuard, setHasCritterGuard] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [warning, setWarning] = useState<string | null>(null);

  // Two-tap delete, same shape as the account-deletion confirm in more.tsx:
  // the first tap only reveals a danger card spelling out what goes, the
  // second one actually calls the RPC. `deleteCanForce` is set when the
  // database refuses because money or hours are attached — that is the only
  // case where a third tap ("Un-assign and delete anyway") is offered.
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [deleteCanForce, setDeleteCanForce] = useState(false);

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
        if (!result) {
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
        const metrics = job as unknown as {
          module_count?: number | null;
          job_type?: JobType | null;
          critter_guard_panels?: number | null;
          has_critter_guard?: boolean | null;
        };
        setModuleCount(
          metrics.module_count != null
            ? String(metrics.module_count)
            : (parseModuleCount(job.name, job.description)?.toString() ?? ''),
        );
        setJobType(metrics.job_type ?? parseJobType(job.name));
        setCritterPanels(
          metrics.critter_guard_panels != null ? String(metrics.critter_guard_panels) : '',
        );
        setHasCritterGuard(
          metrics.has_critter_guard ?? (metrics.job_type ?? parseJobType(job.name)) === 'Critter Guard',
        );
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
    haptics.success();
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
      // Blank falls back to whatever the text says, so a new job written as
      // "R&R … (22 modules)" fills itself in; typing a number always wins.
      module_count:
        moduleCount.trim() !== ''
          ? Number(moduleCount.replace(/[^0-9]/g, '')) || null
          : parseModuleCount(name, description),
      job_type: jobType,
      has_critter_guard: hasCritterGuard,
      // Blank means "the whole array" — metrics fall back to module_count.
      critter_guard_panels:
        hasCritterGuard && critterPanels.trim() !== ''
          ? Number(critterPanels.replace(/[^0-9]/g, '')) || null
          : null,
    };

    setSaving(true);
    if (isEdit) {
      const result = await updateJob(jobId, fields);
      setSaving(false);
      if (!result.ok) {
        setError(result.message);
        return;
      }
      haptics.success();
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
      haptics.success();
      if (result.warning) setWarning(result.warning);
      router.replace({ pathname: '/job/[id]', params: { id: result.id } });
    }
  };

  const removeProject = async (force: boolean) => {
    if (!jobId) return;
    setDeleteError(null);
    setDeleting(true);
    const result = await deleteJob(jobId, { force });
    if (!result.ok) {
      setDeleting(false);
      setDeleteError(result.message);
      setDeleteCanForce(result.canForce);
      haptics.error();
      return;
    }
    haptics.warn();
    // Back to the board, not back to the detail screen of a job that no
    // longer exists.
    router.replace('/pipeline');
  };

  const screenTitle = isEdit ? 'Edit project' : 'New project';

  if (role === 'loading' || loading) {
    return (
      <>
        <Stack.Screen options={{ title: screenTitle }} />
        <Screen edges={[]}>
          <SkeletonList count={4} height={120} />
        </Screen>
      </>
    );
  }

  if (!role || !role.isAdmin) {
    return (
      <>
        <Stack.Screen options={{ title: screenTitle }} />
        <Screen edges={[]}>
          <Card>
            <EmptyState
              icon="lock-closed"
              title="Admins only"
              body="Editing projects is only available to admins. Please sign in with an admin account."
            />
          </Card>
        </Screen>
      </>
    );
  }

  if (notFound) {
    return (
      <>
        <Stack.Screen options={{ title: screenTitle }} />
        <Screen edges={[]}>
          <Card>
            <EmptyState
              icon="help-circle"
              title="Job not found."
              body="It may have been deleted, or the link is out of date."
            />
          </Card>
        </Screen>
      </>
    );
  }

  return (
    <>
      <Stack.Screen options={{ title: screenTitle }} />
      <Screen edges={[]}>
        <Card style={styles.headerCard}>
          <AppText variant="section" color={colors.textMuted}>
            {isEdit ? 'Project' : 'New project'}
          </AppText>
          <Chip label={jobNumber ?? 'DC-…'} icon="pricetag" tone="olive" />
          {!isEdit ? (
            <AppText variant="caption" color={colors.textMuted}>
              Job number is assigned automatically.
            </AppText>
          ) : null}
        </Card>

        <SectionHeader title="Details" icon="clipboard" />
        <Card>
          <Field
            label="Name"
            value={name}
            onChangeText={setName}
            placeholder="e.g. Install 24 modules"
          />
          <Field
            label="Description"
            value={description}
            onChangeText={setDescription}
            placeholder="Scope of work, notes for the crew…"
            multiline
          />

          <View style={styles.field}>
            <AppText variant="section" color={colors.textMuted}>
              Stage
            </AppText>
            <View style={styles.chipRow}>
              {STAGES.map((s) => (
                <Chip
                  key={s}
                  label={s}
                  tone="olive"
                  selected={stage === s}
                  onPress={() => setStage(s)}
                />
              ))}
            </View>
          </View>

          <View style={styles.field}>
            <AppText variant="section" color={colors.textMuted}>
              Job type
            </AppText>
            <View style={styles.chipRow}>
              {JOB_TYPES.map((t) => (
                <Chip
                  key={t}
                  label={t}
                  tone="ocean"
                  selected={jobType === t}
                  onPress={() => setJobType(t)}
                />
              ))}
            </View>
            <AppText variant="caption" color={colors.textMuted}>
              Removal &amp; reinstall work takes longer per panel than a fresh install, so this
              picks which finished jobs the hours forecast learns from.
            </AppText>
          </View>

          <Field
            label="Modules / panels"
            value={moduleCount}
            onChangeText={setModuleCount}
            placeholder="Leave blank to read it from the job name"
            keyboardType="number-pad"
            style={styles.tightField}
          />
          <AppText variant="caption" color={colors.textMuted} style={styles.hint}>
            Drives the panel totals on the pipeline header and the estimated hours on each project
            card.
          </AppText>

          {/* Critter guard is a FLAG, not a job type — most of it is installed
              as part of an R&R, so any job can carry it. */}
          <AnimatedPressable
            onPress={() => setHasCritterGuard((on) => !on)}
            haptic="tapLight"
            scaleTo={0.99}
            accessibilityRole="checkbox"
            accessibilityState={{ checked: hasCritterGuard }}
            accessibilityLabel="Critter guard installed on this job"
            style={styles.checkRow}>
            <Ionicons
              name={hasCritterGuard ? 'checkbox' : 'square-outline'}
              size={20}
              color={colors.accentPrimary}
            />
            <AppText variant="bodyStrong">Critter guard installed on this job</AppText>
          </AnimatedPressable>

          {hasCritterGuard ? (
            <>
              <Field
                label="Critter guard panels (optional)"
                value={critterPanels}
                onChangeText={setCritterPanels}
                placeholder="Blank = every panel on the job"
                keyboardType="number-pad"
                style={styles.tightField}
              />
              <AppText variant="caption" color={colors.textMuted} style={styles.hint}>
                Only counted once the job reaches Complete. Leave blank if the guard covers the
                whole array — the total then follows the module count automatically.
              </AppText>
            </>
          ) : null}

          {stage === 'Complete' ? (
            <Field
              label="Completed date (YYYY-MM-DD)"
              value={completedOn}
              onChangeText={setCompletedOn}
              placeholder={`Leave blank for today (${todayISO()})`}
              autoCapitalize="none"
              autoCorrect={false}
            />
          ) : null}

          <Field
            label="Address"
            value={address}
            onChangeText={setAddress}
            placeholder="Street, city, state"
          />
        </Card>

        <SectionHeader title="Project manager" icon="person-circle" />
        <Card>
          <Field
            label="Name"
            value={projectManager}
            onChangeText={setProjectManager}
            placeholder="Who's running this job?"
          />
          <Field
            label="Cell number"
            value={pmPhone}
            onChangeText={setPmPhone}
            placeholder="(913) 555-0100"
            keyboardType="phone-pad"
          />
        </Card>

        <SectionHeader title="Customer" icon="people" />
        <Card padded={false}>
          {customers.length > 4 ? (
            <View style={styles.inset}>
              <Field
                label="Search"
                value={customerSearch}
                onChangeText={setCustomerSearch}
                placeholder="Search customers"
                style={styles.lastField}
              />
            </View>
          ) : null}

          <ListRow
            title="No customer"
            chevron={false}
            divider
            onPress={() => setCustomerId(null)}
            right={
              customerId === null ? (
                <Ionicons name="checkmark-circle" size={20} color={colors.accentPrimary} />
              ) : undefined
            }
          />

          {filteredCustomers.map((customer, index) => (
            <ListRow
              key={customer.id}
              title={customer.name}
              subtitle={customer.address ?? undefined}
              chevron={false}
              divider={index < filteredCustomers.length - 1}
              onPress={() => setCustomerId(customer.id)}
              right={
                customer.id === customerId ? (
                  <Ionicons name="checkmark-circle" size={20} color={colors.accentPrimary} />
                ) : undefined
              }
            />
          ))}

          {customers.length === 0 ? (
            <AppText variant="caption" color={colors.textMuted} style={styles.inset}>
              No customers available.
            </AppText>
          ) : filteredCustomers.length === 0 ? (
            <AppText variant="caption" color={colors.textMuted} style={styles.inset}>
              No customers match &quot;{customerSearch.trim()}&quot;.
            </AppText>
          ) : null}

          {selectedCustomer && customerSearch ? (
            <AppText variant="caption" color={colors.accentPrimary} style={styles.inset}>
              Selected: {selectedCustomer.name}
            </AppText>
          ) : null}

          {!showNewCustomer ? (
            <ListRow
              icon="person-add"
              title="+ New customer"
              chevron={false}
              style={styles.rowBorderTop}
              onPress={() => {
                setShowNewCustomer(true);
                setNcError(null);
              }}
            />
          ) : (
            <View style={[styles.inset, styles.rowBorderTop]}>
              <AppText variant="heading" style={styles.newCustomerTitle}>
                New customer
              </AppText>
              <Field
                label="Name"
                value={ncName}
                onChangeText={setNcName}
                placeholder="Customer name"
              />
              <Field
                label="Phone"
                value={ncPhone}
                onChangeText={setNcPhone}
                placeholder="(913) 555-0100"
                keyboardType="phone-pad"
              />
              <Field
                label="Email"
                value={ncEmail}
                onChangeText={setNcEmail}
                placeholder="name@example.com"
                keyboardType="email-address"
                autoCapitalize="none"
              />
              <Field
                label="Address"
                value={ncAddress}
                onChangeText={setNcAddress}
                placeholder="Street, city, state"
              />
              {ncError ? (
                <AppText variant="caption" color={colors.danger} align="center">
                  {ncError}
                </AppText>
              ) : null}
              <View style={styles.newCustomerButtons}>
                <Button
                  label="Cancel"
                  variant="ghost"
                  size="sm"
                  disabled={ncSaving}
                  onPress={resetNewCustomerForm}
                />
                <Button
                  label="Add customer"
                  size="sm"
                  loading={ncSaving}
                  disabled={ncSaving}
                  onPress={addNewCustomer}
                />
              </View>
            </View>
          )}
        </Card>

        {error ? (
          <AppText variant="caption" color={colors.danger} align="center">
            {error}
          </AppText>
        ) : null}
        {warning ? (
          <AppText variant="caption" color={colors.danger} align="center">
            {warning}
          </AppText>
        ) : null}

        <Button
          label={saving ? 'Saving…' : isEdit ? 'Save changes' : 'Create project'}
          icon={isEdit ? 'save' : 'add-circle'}
          onPress={save}
          loading={saving}
          disabled={saving}
          size="lg"
          fullWidth
          style={styles.saveButton}
        />

        {/* Deleting is edit-mode only and lives below the save button, where
            it cannot be hit by someone reaching for it. */}
        {isEdit ? (
          confirmingDelete ? (
            <Card tone="danger" style={styles.dangerCard}>
              <AppText variant="heading" color={colors.danger}>
                Delete {jobNumber ?? 'this project'}?
              </AppText>
              <AppText variant="body" color={colors.textSecondary}>
                Removes {jobNumber ?? 'the project'}, its schedule, crew, photos, documents,
                materials and artwork. Money and hours are never deleted; they get un-assigned.
              </AppText>
              <AppText variant="caption" color={colors.textMuted}>
                {jobNumber ?? 'The number'} goes back into the pool — the next project you create
                will take it.
              </AppText>
              {deleteError ? (
                <AppText variant="bodyStrong" color={colors.danger}>
                  {deleteError}
                </AppText>
              ) : null}
              <View style={styles.dangerRow}>
                <Button
                  label="Cancel"
                  variant="ghost"
                  size="sm"
                  disabled={deleting}
                  onPress={() => {
                    setConfirmingDelete(false);
                    setDeleteError(null);
                    setDeleteCanForce(false);
                  }}
                />
                <Button
                  label={deleteCanForce ? 'Un-assign and delete anyway' : 'Delete project'}
                  variant="danger"
                  size="sm"
                  loading={deleting}
                  disabled={deleting}
                  onPress={() => removeProject(deleteCanForce)}
                />
              </View>
            </Card>
          ) : (
            <AnimatedPressable
              onPress={() => {
                setConfirmingDelete(true);
                setDeleteError(null);
                setDeleteCanForce(false);
              }}
              haptic="tapLight"
              hitSlop={8}
              accessibilityRole="button"
              accessibilityLabel={`Delete ${jobNumber ?? 'this project'}`}
              style={styles.deleteLinkWrap}>
              <Ionicons name="trash" size={16} color={colors.danger} />
              <AppText variant="caption" color={colors.danger}>
                Delete project
              </AppText>
            </AnimatedPressable>
          )
        ) : null}
      </Screen>
    </>
  );
}

const styles = StyleSheet.create({
  headerCard: {
    gap: spacing.xs,
    alignItems: 'flex-start',
  },
  field: {
    gap: 4,
    marginBottom: spacing.sm,
  },
  // Pulls a hint up under the field it explains.
  tightField: {
    marginBottom: spacing.xs,
  },
  hint: {
    marginBottom: spacing.sm,
  },
  lastField: {
    marginBottom: 0,
  },
  chipRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.sm,
    marginBottom: spacing.xs,
  },
  checkRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingVertical: spacing.sm,
  },
  inset: {
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
  },
  rowBorderTop: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
  },
  newCustomerTitle: {
    marginBottom: spacing.sm,
  },
  newCustomerButtons: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    alignItems: 'center',
    gap: spacing.sm,
    marginTop: spacing.xs,
  },
  saveButton: {
    marginTop: spacing.sm,
  },
  dangerCard: {
    gap: spacing.sm,
    borderWidth: 1,
    borderColor: colors.danger,
    marginTop: spacing.md,
  },
  dangerRow: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    alignItems: 'center',
    gap: spacing.sm,
    marginTop: spacing.xs,
  },
  deleteLinkWrap: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.xs,
    paddingVertical: spacing.md,
    marginTop: spacing.sm,
  },
});
