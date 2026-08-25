import Ionicons from '@expo/vector-icons/Ionicons';
import { useMemo, useState } from 'react';
import { ActivityIndicator, ScrollView, StyleSheet, View } from 'react-native';

import {
  AnimatedPressable,
  AppText,
  Button,
  Card,
  Chip,
  FadeInUp,
  SectionHeader,
} from '@/components/ui';
import { colors, radii, spacing } from '@/constants/theme';
import { formatShortDate } from '@/lib/dates';
import type { LedgerEntry } from '@/lib/financials';
import { Field } from '@/components/forms/Field';
import { formatMoney } from './format';

/** Compact picker option for tying an expense to a job. */
export interface JobOption {
  id: string;
  label: string;
  /** Extra fields the search box matches against, beyond `label`. */
  customerName?: string | null;
  address?: string | null;
}

/** Only worth a search box once scrubbing the chip row itself gets old. */
const SEARCH_THRESHOLD = 6;

/**
 * "Which job is this expense on?" — the Company container job first (that is
 * the ONE way to say "overhead"), then every real job.
 *
 * `Chip` carries its own selection tick haptic, so tapping through the row on
 * a phone feels like scrubbing a dial.
 */
export function JobPicker({
  label,
  options,
  companyJobId,
  selected,
  onSelect,
}: {
  label: string;
  options: JobOption[];
  companyJobId: string | null;
  selected: string | null;
  onSelect: (id: string | null) => void;
}) {
  const [query, setQuery] = useState('');

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return options;
    return options.filter((option) =>
      [option.label, option.customerName, option.address].some((field) =>
        field?.toLowerCase().includes(q),
      ),
    );
  }, [options, query]);

  return (
    <View style={styles.field}>
      <AppText variant="section" color={colors.textMuted}>
        {label}
      </AppText>
      {options.length > SEARCH_THRESHOLD ? (
        <Field
          label="Search"
          value={query}
          onChangeText={setQuery}
          placeholder="Search job, customer or address"
          style={styles.searchField}
        />
      ) : null}
      <ScrollView horizontal showsHorizontalScrollIndicator={false}>
        <View style={styles.chipRow}>
          <Chip
            label="Company"
            tone="olive"
            selected={selected === companyJobId}
            onPress={() => onSelect(companyJobId)}
          />
          {filtered.map((option) => (
            <Chip
              key={option.id}
              label={option.label}
              tone="ocean"
              selected={selected === option.id}
              onPress={() => onSelect(option.id)}
            />
          ))}
          {filtered.length === 0 ? (
            <AppText variant="caption" color={colors.textMuted} style={styles.noMatches}>
              No jobs match &quot;{query.trim()}&quot;.
            </AppText>
          ) : null}
        </View>
      </ScrollView>
    </View>
  );
}

/** The collapsible "+ Add expense" form. */
export function ExpenseForm({
  amount,
  onAmount,
  description,
  onDescription,
  paidTo,
  onPaidTo,
  date,
  onDate,
  jobId,
  onJobId,
  jobOptions,
  companyJobId,
  saving,
  onSave,
}: {
  amount: string;
  onAmount: (text: string) => void;
  description: string;
  onDescription: (text: string) => void;
  paidTo: string;
  onPaidTo: (text: string) => void;
  date: string;
  onDate: (text: string) => void;
  jobId: string | null;
  onJobId: (id: string | null) => void;
  jobOptions: JobOption[];
  companyJobId: string | null;
  saving: boolean;
  onSave: () => void;
}) {
  return (
    <Card style={styles.formCard}>
      <Field
        label="Amount ($)"
        value={amount}
        onChangeText={onAmount}
        placeholder="0.00"
        keyboardType="decimal-pad"
      />
      <Field
        label="Description"
        value={description}
        onChangeText={onDescription}
        placeholder="What was this for?"
      />
      <Field
        label="Paid to (optional)"
        value={paidTo}
        onChangeText={onPaidTo}
        placeholder="Vendor or store"
      />
      <Field
        label="Date (YYYY-MM-DD)"
        value={date}
        onChangeText={onDate}
        placeholder="YYYY-MM-DD"
        autoCapitalize="none"
        autoCorrect={false}
      />
      {jobOptions.length > 0 ? (
        <JobPicker
          label="Job (optional)"
          options={jobOptions}
          companyJobId={companyJobId}
          selected={jobId}
          onSelect={onJobId}
        />
      ) : null}
      <Button
        label="Record expense"
        icon="pricetag"
        onPress={onSave}
        loading={saving}
        disabled={saving}
        fullWidth
        style={styles.saveButton}
      />
    </Card>
  );
}

/** The collapsible header above each month of expenses. */
export function MonthHeader({
  label,
  count,
  total,
  open,
  onToggle,
  noun = 'expense',
}: {
  label: string;
  count: number;
  total: number;
  open: boolean;
  onToggle: () => void;
  /** What is being counted — 'expense' (default) or 'payroll'. */
  noun?: string;
}) {
  return (
    <AnimatedPressable
      onPress={onToggle}
      haptic="tapLight"
      scaleTo={0.995}
      accessibilityRole="button"
      accessibilityState={{ expanded: open }}
      accessibilityLabel={`${label}, ${count} ${noun}s`}
      style={styles.monthHeader}>
      <SectionHeader
        title={label}
        subtitle={`${count} ${count === 1 ? noun : `${noun}s`}`}
        icon={open ? 'chevron-down' : 'chevron-forward'}
        style={styles.monthSection}
      />
      <AppText variant="bodyStrong" style={styles.figure}>
        {formatMoney(total)}
      </AppText>
    </AnimatedPressable>
  );
}

/**
 * One payroll run inside a month's "Labor Report" dropdown — display-only:
 * runs are recorded and corrected on the Hours tab, not here.
 */
export function LaborReportRow({
  title,
  caption,
  amount,
  index,
  isFirst,
  isLast,
}: {
  title: string;
  caption: string;
  amount: number;
  index: number;
  isFirst: boolean;
  isLast: boolean;
}) {
  return (
    <FadeInUp index={index}>
      <View
        style={[
          styles.rowCard,
          !isFirst && styles.rowBorderTop,
          isFirst && styles.rowFirst,
          isLast && styles.rowLast,
        ]}>
        <View style={styles.row}>
          <View style={styles.iconWrap}>
            <Ionicons name="people" size={18} color={colors.accentPrimary} />
          </View>
          <View style={styles.rowBody}>
            <AppText variant="bodyStrong" numberOfLines={1}>
              {title}
            </AppText>
            <AppText variant="caption" color={colors.textMuted}>
              {caption}
            </AppText>
          </View>
          <AppText variant="bodyStrong" style={styles.figure}>
            {formatMoney(amount)}
          </AppText>
        </View>
      </View>
    </FadeInUp>
  );
}

/**
 * One expense in the ledger, with its inline editor.
 *
 * The two-tap delete is unchanged: the first tap arms the row (red trash + a
 * one-line hint), the second one actually deletes. That is deliberately not a
 * confirm dialog — this list is edited fast, on a phone, with gloves on.
 */
export function ExpenseRow({
  entry,
  index,
  isFirst,
  isLast,
  jobLabel,
  editing,
  confirming,
  busyDelete,
  savingEdit,
  editAmount,
  onEditAmount,
  editDate,
  onEditDate,
  editDescription,
  onEditDescription,
  editJobId,
  onEditJobId,
  jobOptions,
  companyJobId,
  onToggleEdit,
  onCancelEdit,
  onSaveEdit,
  onDelete,
}: {
  entry: LedgerEntry;
  index: number;
  isFirst: boolean;
  isLast: boolean;
  jobLabel: string | null;
  editing: boolean;
  confirming: boolean;
  busyDelete: boolean;
  savingEdit: boolean;
  editAmount: string;
  onEditAmount: (text: string) => void;
  editDate: string;
  onEditDate: (text: string) => void;
  editDescription: string;
  onEditDescription: (text: string) => void;
  editJobId: string | null;
  onEditJobId: (id: string | null) => void;
  jobOptions: JobOption[];
  companyJobId: string | null;
  onToggleEdit: () => void;
  onCancelEdit: () => void;
  onSaveEdit: () => void;
  onDelete: () => void;
}) {
  return (
    <FadeInUp index={index}>
      <View
        style={[
          styles.rowCard,
          !isFirst && styles.rowBorderTop,
          isFirst && styles.rowFirst,
          isLast && styles.rowLast,
        ]}>
        <View style={styles.row}>
          <View style={styles.iconWrap}>
            <Ionicons name="pricetag" size={18} color={colors.accentPrimary} />
          </View>

          <View style={styles.rowBody}>
            <AppText variant="bodyStrong" numberOfLines={1}>
              {entry.description ?? entry.counterparty ?? 'Expense'}
            </AppText>
            <View style={styles.metaRow}>
              {jobLabel ? <Chip label={jobLabel} tone="ocean" /> : null}
              <AppText variant="caption" color={colors.textMuted} style={styles.metaText}>
                {formatShortDate(entry.occurred_on)}
                {entry.counterparty && entry.description ? ` · ${entry.counterparty}` : ''}
              </AppText>
            </View>
          </View>

          <AppText variant="bodyStrong" style={styles.figure}>
            {formatMoney(entry.amount)}
          </AppText>

          <AnimatedPressable
            onPress={onToggleEdit}
            haptic="tapLight"
            hitSlop={6}
            accessibilityRole="button"
            accessibilityLabel={editing ? 'Close editor' : 'Edit expense'}
            style={styles.iconButton}>
            <Ionicons name="pencil" size={15} color={colors.accentPrimary} />
          </AnimatedPressable>

          <AnimatedPressable
            onPress={onDelete}
            disabled={busyDelete}
            haptic={confirming ? 'warn' : 'tapLight'}
            hitSlop={6}
            accessibilityRole="button"
            accessibilityLabel={confirming ? 'Confirm delete' : 'Delete expense'}
            style={[styles.iconButton, confirming && styles.iconButtonDanger]}>
            {busyDelete ? (
              <ActivityIndicator size="small" color={colors.danger} />
            ) : (
              <Ionicons
                name="trash"
                size={15}
                color={confirming ? colors.white : colors.textMuted}
              />
            )}
          </AnimatedPressable>
        </View>

        {confirming ? (
          <AppText variant="caption" color={colors.danger} style={styles.confirmHint}>
            Tap the trash again to delete this expense.
          </AppText>
        ) : null}

        {editing ? (
          <Card tone="sunk" style={styles.editCard}>
            <Field
              label="Amount ($)"
              value={editAmount}
              onChangeText={onEditAmount}
              placeholder="0.00"
              keyboardType="decimal-pad"
            />
            <Field
              label="Date (YYYY-MM-DD)"
              value={editDate}
              onChangeText={onEditDate}
              placeholder="YYYY-MM-DD"
              autoCapitalize="none"
              autoCorrect={false}
            />
            <Field
              label="Description"
              value={editDescription}
              onChangeText={onEditDescription}
              placeholder="Description"
            />
            {jobOptions.length > 0 ? (
              <JobPicker
                label="Job"
                options={jobOptions}
                companyJobId={companyJobId}
                selected={editJobId}
                onSelect={onEditJobId}
              />
            ) : null}
            <View style={styles.editButtons}>
              <Button
                label="Cancel"
                variant="ghost"
                size="sm"
                disabled={savingEdit}
                onPress={onCancelEdit}
              />
              <Button
                label="Save"
                size="sm"
                loading={savingEdit}
                disabled={savingEdit}
                onPress={onSaveEdit}
              />
            </View>
          </Card>
        ) : null}
      </View>
    </FadeInUp>
  );
}

const styles = StyleSheet.create({
  field: {
    gap: 4,
    marginBottom: spacing.sm,
  },
  chipRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    paddingVertical: spacing.xs,
  },
  searchField: {
    marginBottom: spacing.xs,
  },
  noMatches: {
    paddingHorizontal: spacing.xs,
  },
  formCard: {
    marginBottom: spacing.md,
  },
  saveButton: {
    marginTop: spacing.xs,
  },
  monthHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    marginTop: spacing.md,
    marginBottom: spacing.xs,
    paddingHorizontal: spacing.xs,
  },
  monthSection: {
    flex: 1,
    marginBottom: 0,
  },
  figure: {
    fontVariant: ['tabular-nums'],
  },
  rowCard: {
    backgroundColor: colors.surface,
  },
  rowFirst: {
    borderTopLeftRadius: radii.md,
    borderTopRightRadius: radii.md,
  },
  rowLast: {
    borderBottomLeftRadius: radii.md,
    borderBottomRightRadius: radii.md,
  },
  rowBorderTop: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    padding: spacing.md,
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
  metaRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
  },
  metaText: {
    flexShrink: 1,
  },
  iconButton: {
    width: 28,
    height: 28,
    borderRadius: radii.sm,
    backgroundColor: colors.oliveSoft,
    alignItems: 'center',
    justifyContent: 'center',
  },
  iconButtonDanger: {
    backgroundColor: colors.danger,
  },
  confirmHint: {
    paddingHorizontal: spacing.md,
    paddingBottom: spacing.sm,
    textAlign: 'right',
  },
  editCard: {
    marginHorizontal: spacing.md,
    marginBottom: spacing.md,
  },
  editButtons: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'flex-end',
    gap: spacing.md,
    marginTop: spacing.xs,
  },
});
