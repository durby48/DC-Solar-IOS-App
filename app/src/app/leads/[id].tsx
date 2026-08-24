import Ionicons from '@expo/vector-icons/Ionicons';
import { Stack, useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useMemo, useState } from 'react';
import { ActivityIndicator, StyleSheet, View } from 'react-native';

import { Field } from '@/components/forms/Field';
import {
  AnimatedPressable,
  AppText,
  Button,
  Card,
  Chip,
  EmptyState,
  Pill,
  Screen,
  SectionHeader,
  SkeletonList,
} from '@/components/ui';
import { colors, radii, spacing } from '@/constants/theme';
import { convertLeadToCustomer } from '@/lib/crm';
import { getDocumentUrl } from '@/lib/data';
import { formatShortDate } from '@/lib/dates';
import type { LineItem } from '@/lib/documents';
import * as haptics from '@/lib/haptics';
import {
  createProjection,
  deleteProjection,
  fetchLeadById,
  fetchProjections,
  regenerateProjectionPdf,
  updateLead,
  type Lead,
  type Projection,
} from '@/lib/leads';
import { viewDocument } from '@/lib/pdf';
import { useRole } from '@/lib/role';
import { setLeadStatus, type LeadStatus } from '@/lib/sales';
import { LEAD_STATUS_LABELS, LEAD_STATUS_ORDER, leadStatusTone } from './index';

function formatMoney(amount: number): string {
  return `$${amount.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** One editable projection line: text fields, parsed on save. */
interface DraftLine {
  name: string;
  qty: string;
  rate: string;
}

const EMPTY_LINE: DraftLine = { name: '', qty: '1', rate: '' };

export default function LeadDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const role = useRole();

  const [lead, setLead] = useState<Lead | null>(null);
  const [projections, setProjections] = useState<Projection[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Contact editing.
  const [editing, setEditing] = useState(false);
  const [editFields, setEditFields] = useState({
    name: '',
    phone: '',
    email: '',
    address: '',
    source: '',
    notes: '',
  });
  const [savingEdit, setSavingEdit] = useState(false);

  // Projection builder.
  const [builderOpen, setBuilderOpen] = useState(false);
  const [lines, setLines] = useState<DraftLine[]>([{ ...EMPTY_LINE }]);
  const [projNotes, setProjNotes] = useState('');
  const [savingProjection, setSavingProjection] = useState(false);

  // Per-row busy states.
  const [busyId, setBusyId] = useState<string | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

  // Conversion.
  const [converting, setConverting] = useState<null | 'customer' | 'project'>(null);

  const load = useCallback(async () => {
    if (!id) return;
    const [fetchedLead, fetchedProjections] = await Promise.all([
      fetchLeadById(id),
      fetchProjections(id),
    ]);
    setLead(fetchedLead);
    setProjections(fetchedProjections);
    setLoaded(true);
  }, [id]);

  useFocusEffect(
    useCallback(() => {
      load();
    }, [load]),
  );

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    try {
      await load();
    } finally {
      setRefreshing(false);
    }
  }, [load]);

  const draftTotal = useMemo(
    () =>
      lines.reduce((sum, line) => {
        const qty = Number(line.qty);
        const rate = Number(line.rate.replace(/[^0-9.]/g, ''));
        return sum + (Number.isFinite(qty) && Number.isFinite(rate) ? qty * rate : 0);
      }, 0),
    [lines],
  );

  const startEdit = () => {
    if (!lead) return;
    setEditFields({
      name: lead.name,
      phone: lead.phone ?? '',
      email: lead.email ?? '',
      address: lead.address ?? '',
      source: lead.source ?? '',
      notes: lead.notes ?? '',
    });
    setEditing(true);
  };

  const saveEdit = async () => {
    if (!lead) return;
    if (!editFields.name.trim()) {
      setError('The lead needs a name.');
      return;
    }
    setSavingEdit(true);
    setError(null);
    const result = await updateLead(lead.id, editFields);
    setSavingEdit(false);
    if (result.ok) {
      setEditing(false);
      await load();
    } else {
      setError(result.message);
    }
  };

  const changeStatus = async (next: LeadStatus) => {
    if (!lead || lead.status === next) return;
    setError(null);
    const result = await setLeadStatus(lead.id, next);
    if (!result.ok) setError(result.message);
    await load();
  };

  const saveProjection = async () => {
    if (!lead) return;
    const items: LineItem[] = [];
    for (const line of lines) {
      if (!line.name.trim()) continue;
      const qty = Number(line.qty);
      const rate = Number(line.rate.replace(/[^0-9.]/g, ''));
      if (!Number.isFinite(qty) || qty <= 0 || !Number.isFinite(rate) || rate < 0) {
        setError(`Check the numbers on "${line.name.trim()}".`);
        return;
      }
      items.push({ name: line.name.trim(), qty, rate });
    }
    if (items.length === 0) {
      setError('Add at least one line item.');
      return;
    }
    setSavingProjection(true);
    setError(null);
    setStatus(null);
    const result = await createProjection({
      lead,
      lineItems: items,
      notes: projNotes.trim() || null,
      createdBy: role?.email ?? null,
    });
    setSavingProjection(false);
    if (result.ok) {
      haptics.success();
      setBuilderOpen(false);
      setLines([{ ...EMPTY_LINE }]);
      setProjNotes('');
      setStatus(
        result.warning ?? `${result.projection.number} created — ${formatMoney(result.projection.total)}.`,
      );
      // A lead with a projection has moved past "contacted" on its own.
      if (lead.status === 'new' || lead.status === 'contacted') {
        await setLeadStatus(lead.id, 'estimating');
      }
      await load();
    } else {
      setError(result.message);
    }
  };

  const openProjection = async (projection: Projection) => {
    setError(null);
    if (!projection.document_path) {
      // PDF failed at create time — retry the render on demand.
      if (!lead) return;
      setBusyId(projection.id);
      const result = await regenerateProjectionPdf(projection, lead);
      setBusyId(null);
      if (!result.ok) {
        setError(result.message);
        return;
      }
      await load();
      const url = await getDocumentUrl(result.path, 1);
      if (url) await viewDocument(url);
      return;
    }
    const url = await getDocumentUrl(projection.document_path, 1);
    if (!url || !(await viewDocument(url))) {
      setError('Could not open the PDF. Please try again.');
    }
  };

  const pressDelete = async (projection: Projection) => {
    if (confirmDeleteId !== projection.id) {
      setConfirmDeleteId(projection.id);
      return;
    }
    setBusyId(projection.id);
    const result = await deleteProjection(projection);
    setBusyId(null);
    setConfirmDeleteId(null);
    if (!result.ok) setError(result.message);
    await load();
  };

  const convert = async (createJob: boolean) => {
    if (!lead) return;
    setConverting(createJob ? 'project' : 'customer');
    setError(null);
    const result = await convertLeadToCustomer(lead.id, { createJob });
    setConverting(null);
    if (!result.ok) {
      setError(result.message);
      return;
    }
    haptics.success();
    if (result.warning) setStatus(result.warning);
    // Land on the new customer — the project (and its estimates, with real
    // financial weight) live there from now on.
    router.replace({ pathname: '/crm/[id]', params: { id: result.customerId } });
  };

  const tone = lead ? leadStatusTone(lead.status) : null;

  return (
    <>
      <Stack.Screen options={{ title: lead?.name ?? 'Lead' }} />
      <Screen edges={[]} refreshing={refreshing} onRefresh={onRefresh}>
        {!loaded ? (
          <SkeletonList count={3} height={120} />
        ) : !lead ? (
          <Card>
            <EmptyState icon="person" title="This lead is not available." />
          </Card>
        ) : (
          <>
            {/* ---- Contact card ---- */}
            <Card style={styles.card}>
              <View style={styles.headerRow}>
                <AppText variant="heading" style={styles.name}>
                  {lead.name}
                </AppText>
                {tone ? (
                  <Pill label={LEAD_STATUS_LABELS[lead.status]} bg={tone.bg} fg={tone.fg} />
                ) : null}
              </View>
              {editing ? (
                <>
                  <Field
                    label="Name"
                    value={editFields.name}
                    onChangeText={(v) => setEditFields((f) => ({ ...f, name: v }))}
                  />
                  <Field
                    label="Phone"
                    value={editFields.phone}
                    onChangeText={(v) => setEditFields((f) => ({ ...f, phone: v }))}
                    keyboardType="phone-pad"
                  />
                  <Field
                    label="Email"
                    value={editFields.email}
                    onChangeText={(v) => setEditFields((f) => ({ ...f, email: v }))}
                    autoCapitalize="none"
                    keyboardType="email-address"
                  />
                  <Field
                    label="Address"
                    value={editFields.address}
                    onChangeText={(v) => setEditFields((f) => ({ ...f, address: v }))}
                  />
                  <Field
                    label="Source"
                    value={editFields.source}
                    onChangeText={(v) => setEditFields((f) => ({ ...f, source: v }))}
                  />
                  <Field
                    label="Notes"
                    value={editFields.notes}
                    onChangeText={(v) => setEditFields((f) => ({ ...f, notes: v }))}
                  />
                  <View style={styles.buttonRow}>
                    <Button
                      label="Cancel"
                      variant="ghost"
                      size="sm"
                      disabled={savingEdit}
                      onPress={() => setEditing(false)}
                    />
                    <Button
                      label="Save"
                      size="sm"
                      loading={savingEdit}
                      disabled={savingEdit}
                      onPress={() => void saveEdit()}
                    />
                  </View>
                </>
              ) : (
                <>
                  {[
                    lead.phone,
                    lead.email,
                    lead.address,
                    lead.source ? `Source: ${lead.source}` : null,
                    lead.notes,
                  ]
                    .filter(Boolean)
                    .map((line) => (
                      <AppText key={line as string} variant="body" color={colors.textSecondary}>
                        {line}
                      </AppText>
                    ))}
                  <Button label="Edit details" size="sm" variant="secondary" onPress={startEdit} />
                </>
              )}
            </Card>

            {/* ---- Status ---- */}
            <SectionHeader title="Stage" />
            <View style={styles.statusRow}>
              {LEAD_STATUS_ORDER.map((key) => (
                <Chip
                  key={key}
                  label={LEAD_STATUS_LABELS[key]}
                  tone="olive"
                  selected={lead.status === key}
                  onPress={() => void changeStatus(key)}
                />
              ))}
            </View>

            {/* ---- Projections ---- */}
            <View style={styles.projHeaderRow}>
              <SectionHeader
                title="Projections"
                subtitle="pre-estimates — never part of the financials"
                style={styles.projHeader}
              />
              <Button
                label={builderOpen ? 'Close' : '+ New projection'}
                size="sm"
                variant={builderOpen ? 'secondary' : 'primary'}
                onPress={() => {
                  setError(null);
                  setBuilderOpen((open) => !open);
                }}
              />
            </View>

            {builderOpen ? (
              <Card style={styles.card}>
                {lines.map((line, index) => (
                  <View key={index} style={styles.lineRow}>
                    <View style={styles.lineName}>
                      <Field
                        label={index === 0 ? 'Line item' : ''}
                        value={line.name}
                        onChangeText={(v) =>
                          setLines((prev) => prev.map((l, i) => (i === index ? { ...l, name: v } : l)))
                        }
                        placeholder="Removal of 20 modules"
                      />
                    </View>
                    <View style={styles.lineQty}>
                      <Field
                        label={index === 0 ? 'Qty' : ''}
                        value={line.qty}
                        onChangeText={(v) =>
                          setLines((prev) => prev.map((l, i) => (i === index ? { ...l, qty: v } : l)))
                        }
                        keyboardType="decimal-pad"
                      />
                    </View>
                    <View style={styles.lineRate}>
                      <Field
                        label={index === 0 ? 'Price' : ''}
                        value={line.rate}
                        onChangeText={(v) =>
                          setLines((prev) => prev.map((l, i) => (i === index ? { ...l, rate: v } : l)))
                        }
                        placeholder="0.00"
                        keyboardType="decimal-pad"
                      />
                    </View>
                    <AnimatedPressable
                      onPress={() =>
                        setLines((prev) =>
                          prev.length === 1 ? [{ ...EMPTY_LINE }] : prev.filter((_, i) => i !== index),
                        )
                      }
                      haptic="tapLight"
                      hitSlop={6}
                      accessibilityRole="button"
                      accessibilityLabel="Remove line"
                      style={styles.lineRemove}>
                      <Ionicons name="close" size={14} color={colors.textMuted} />
                    </AnimatedPressable>
                  </View>
                ))}
                <Button
                  label="+ Add line"
                  size="sm"
                  variant="ghost"
                  onPress={() => setLines((prev) => [...prev, { ...EMPTY_LINE }])}
                />
                <Field
                  label="Notes (optional)"
                  value={projNotes}
                  onChangeText={setProjNotes}
                  placeholder="Assumptions, scope, timeline…"
                />
                <View style={styles.totalRow}>
                  <AppText variant="bodyStrong">Projection total</AppText>
                  <AppText variant="bodyStrong" style={styles.figure}>
                    {formatMoney(draftTotal)}
                  </AppText>
                </View>
                <Button
                  label="Create DC Solar Projection (PDF)"
                  icon="document-text"
                  onPress={() => void saveProjection()}
                  loading={savingProjection}
                  disabled={savingProjection}
                  fullWidth
                />
              </Card>
            ) : null}

            {projections.length === 0 && !builderOpen ? (
              <Card style={styles.card}>
                <EmptyState
                  icon="document-text"
                  title="No projections yet."
                  body="A projection is a pre-estimate PDF for this lead. It carries no financial weight — real estimates come after conversion."
                />
              </Card>
            ) : (
              <Card padded={false} style={styles.card}>
                {projections.map((projection, index) => {
                  const confirming = confirmDeleteId === projection.id;
                  const busy = busyId === projection.id;
                  return (
                    <View
                      key={projection.id}
                      style={[styles.projRow, index > 0 && styles.rowBorderTop]}>
                      <AnimatedPressable
                        onPress={() => void openProjection(projection)}
                        haptic="tapLight"
                        scaleTo={0.99}
                        accessibilityRole="button"
                        accessibilityLabel={projection.number}
                        style={styles.projBody}>
                        <View style={styles.projText}>
                          <AppText variant="bodyStrong">{projection.number}</AppText>
                          <AppText variant="caption" color={colors.textMuted}>
                            {formatShortDate(projection.created_at.slice(0, 10))}
                            {projection.document_path ? ' · PDF' : ' · PDF pending — tap to render'}
                          </AppText>
                        </View>
                        <AppText variant="bodyStrong" style={styles.figure}>
                          {formatMoney(projection.total)}
                        </AppText>
                      </AnimatedPressable>
                      <AnimatedPressable
                        onPress={() => void pressDelete(projection)}
                        disabled={busy}
                        haptic={confirming ? 'warn' : 'tapLight'}
                        hitSlop={6}
                        accessibilityRole="button"
                        accessibilityLabel={confirming ? 'Confirm delete' : 'Delete projection'}
                        style={[styles.iconButton, confirming && styles.iconButtonDanger]}>
                        {busy ? (
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
                  );
                })}
              </Card>
            )}

            {/* ---- Conversion ---- */}
            <SectionHeader
              title="Convert"
              subtitle="turns this lead into a customer — money starts here"
            />
            <Card style={styles.card}>
              <AppText variant="caption" color={colors.textMuted}>
                Converting creates the customer record{' '}
                (and optionally the project with a DC job number). Estimates, invoices and every
                financial figure belong to the project — never to the lead.
              </AppText>
              <View style={styles.buttonRow}>
                <Button
                  label="Convert to customer"
                  size="sm"
                  variant="secondary"
                  loading={converting === 'customer'}
                  disabled={converting !== null}
                  onPress={() => void convert(false)}
                />
                <Button
                  label="Convert + create project"
                  size="sm"
                  loading={converting === 'project'}
                  disabled={converting !== null}
                  onPress={() => void convert(true)}
                />
              </View>
            </Card>

            {error ? (
              <AppText variant="caption" color={colors.danger} align="center">
                {error}
              </AppText>
            ) : null}
            {status ? (
              <AppText variant="caption" color={colors.accentPrimary} align="center">
                {status}
              </AppText>
            ) : null}
          </>
        )}
      </Screen>
    </>
  );
}

const styles = StyleSheet.create({
  card: {
    marginBottom: spacing.md,
    gap: spacing.xs,
  },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.sm,
  },
  name: {
    flexShrink: 1,
  },
  buttonRow: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    gap: spacing.sm,
    marginTop: spacing.xs,
  },
  statusRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.xs,
    marginBottom: spacing.md,
  },
  projHeaderRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
  },
  projHeader: {
    flex: 1,
  },
  lineRow: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: spacing.xs,
  },
  lineName: {
    flex: 1,
  },
  lineQty: {
    width: 56,
  },
  lineRate: {
    width: 88,
  },
  lineRemove: {
    width: 24,
    height: 24,
    borderRadius: radii.sm,
    backgroundColor: colors.surfaceSunk,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: spacing.sm + 2,
  },
  totalRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: spacing.xs,
  },
  figure: {
    fontVariant: ['tabular-nums'],
  },
  projRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingRight: spacing.sm,
  },
  rowBorderTop: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
  },
  projBody: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    padding: spacing.md,
  },
  projText: {
    flex: 1,
    gap: 2,
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
});
