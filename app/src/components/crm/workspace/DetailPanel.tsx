import Ionicons from '@expo/vector-icons/Ionicons';
import { useRouter } from 'expo-router';
import { useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';

import { Pill } from '@/components/ui';
import { colors, radii, spacing } from '@/constants/theme';
import { type Assignment } from '@/lib/assignments';
import { formatPhone } from '@/lib/comms';
import { updateCustomer, type CustomerFinanceRow, type CustomerJob } from '@/lib/crm';
import { LEAD_STATUS_LABEL, LEAD_STATUS_ORDER, type WorkspaceRecord } from '@/lib/crmWorkspace';
import { type CustomerDocument } from '@/lib/customers';
import { updateLead } from '@/lib/leads';
import { assignLead, setLeadStatus, type LeadStatus } from '@/lib/sales';
import { STAGE_COLORS, isStage } from '@/lib/stages';

/**
 * The right column: the record's facts, editable in place.
 *
 * Contact, jobs (current one first, stage pill, tap to open), lead funnel
 * (status chips write straight through `setLeadStatus`, the rep picker
 * through `assignLead` — the same functions the Sales tab uses), the money
 * rollup where the caller may see money, the next scheduled day, who is
 * assigned, and files. Tasks and Email are listed as what they are: not
 * built yet. No faked panels.
 *
 * Pattern: Chatwoot's ContactPanel / Twenty's editable field panel — small
 * label-over-value rows, an Edit toggle that turns the section into inputs,
 * Save/Cancel, nothing modal.
 */

function money(amount: number): string {
  return `$${Math.round(amount).toLocaleString('en-US')}`;
}

function shortDate(iso: string | null): string {
  if (!iso) return '';
  const [y, m, d] = iso.slice(0, 10).split('-').map(Number);
  if (!y || !m || !d) return iso;
  return new Date(y, m - 1, d).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
}

function Section({ title, children, right }: { title: string; children: React.ReactNode; right?: React.ReactNode }) {
  return (
    <View style={styles.section}>
      <View style={styles.sectionHead}>
        <Text style={styles.sectionTitle}>{title}</Text>
        {right}
      </View>
      {children}
    </View>
  );
}

function Fact({ label, value, muted }: { label: string; value: string | null | undefined; muted?: boolean }) {
  return (
    <View style={styles.fact}>
      <Text style={styles.factLabel}>{label}</Text>
      <Text style={[styles.factValue, (!value || muted) && styles.factMuted]} numberOfLines={3} selectable>
        {value || '—'}
      </Text>
    </View>
  );
}

export function DetailPanel({
  record,
  jobs,
  finance,
  documents,
  assignments,
  reps,
  hasMoney,
  onChanged,
  onClose,
}: {
  record: WorkspaceRecord;
  jobs: CustomerJob[];
  finance: CustomerFinanceRow[];
  documents: CustomerDocument[];
  assignments: Assignment[];
  reps: { email: string; name: string }[];
  hasMoney: boolean;
  onChanged: () => void;
  /** Narrow layouts: the panel is a sheet with a close. */
  onClose?: () => void;
}) {
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState({ name: '', phone: '', email: '', address: '' });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [statusBusy, setStatusBusy] = useState<LeadStatus | null>(null);
  const [repOpen, setRepOpen] = useState(false);

  useEffect(() => {
    setEditing(false);
    setError(null);
    setForm({
      name: record.name,
      phone: record.phone ?? '',
      email: record.email ?? '',
      address: record.address ?? '',
    });
  }, [record.key, record.name, record.phone, record.email, record.address]);

  const save = async () => {
    setSaving(true);
    setError(null);
    const result =
      record.kind === 'customer'
        ? await updateCustomer(record.id, {
            name: form.name.trim(),
            phone: form.phone.trim() || null,
            email: form.email.trim() || null,
            address: form.address.trim() || null,
            notes: record.customer?.notes ?? null,
          })
        : await updateLead(record.id, {
            name: form.name.trim(),
            phone: form.phone.trim() || null,
            email: form.email.trim() || null,
            address: form.address.trim() || null,
          });
    setSaving(false);
    if (result.ok) {
      setEditing(false);
      onChanged();
    } else {
      setError(result.message);
    }
  };

  const moveLead = async (status: LeadStatus) => {
    if (!record.lead || record.lead.status === status) return;
    setStatusBusy(status);
    const result = await setLeadStatus(record.id, status);
    setStatusBusy(null);
    if (result.ok) onChanged();
    else setError(result.message);
  };

  const assign = async (email: string | null) => {
    setRepOpen(false);
    const result = await assignLead(record.id, email);
    if (result.ok) onChanged();
    else setError(result.message);
  };

  const current = record.currentJob;
  const orderedJobs = [...jobs].sort((a, b) => (a.id === current?.id ? -1 : b.id === current?.id ? 1 : 0));
  const nextDay = jobs
    .map((j) => j.scheduled_for)
    .filter((d): d is string => Boolean(d) && (d as string) >= new Date().toISOString().slice(0, 10))
    .sort()[0];
  const crew = current ? assignments.filter((a) => a.job_id === current.id) : [];
  const docs = finance.filter((f) => f.document_path);
  const summary = record.summary;
  const rep = record.lead?.assigned_to ?? null;
  const repName = rep ? (reps.find((r) => r.email.toLowerCase() === rep.toLowerCase())?.name ?? rep) : null;

  return (
    <ScrollView style={styles.column} contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
      {onClose ? (
        <Pressable onPress={onClose} style={({ pressed }) => [styles.close, pressed && styles.pressed]}>
          <Ionicons name="chevron-back" size={16} color={colors.ocean} />
          <Text style={styles.closeText}>Back to conversation</Text>
        </Pressable>
      ) : null}

      <Section
        title="Contact"
        right={
          editing ? null : (
            <Pressable onPress={() => setEditing(true)} hitSlop={6} accessibilityLabel="Edit contact">
              <Ionicons name="create-outline" size={16} color={colors.ocean} />
            </Pressable>
          )
        }>
        {editing ? (
          <View style={styles.form}>
            {(['name', 'phone', 'email', 'address'] as const).map((field) => (
              <TextInput
                key={field}
                value={form[field]}
                onChangeText={(v) => setForm((f) => ({ ...f, [field]: v }))}
                placeholder={field.charAt(0).toUpperCase() + field.slice(1)}
                placeholderTextColor={colors.inkSoft}
                autoCapitalize={field === 'email' ? 'none' : 'sentences'}
                keyboardType={field === 'phone' ? 'phone-pad' : field === 'email' ? 'email-address' : 'default'}
                style={styles.input}
              />
            ))}
            {error ? <Text style={styles.error}>{error}</Text> : null}
            <View style={styles.formButtons}>
              <Pressable onPress={() => setEditing(false)} style={({ pressed }) => [styles.cancel, pressed && styles.pressed]}>
                <Text style={styles.cancelText}>Cancel</Text>
              </Pressable>
              <Pressable onPress={() => void save()} disabled={saving} style={({ pressed }) => [styles.save, (pressed || saving) && styles.pressed]}>
                {saving ? <ActivityIndicator color={colors.ink} size="small" /> : <Text style={styles.saveText}>Save</Text>}
              </Pressable>
            </View>
          </View>
        ) : (
          <>
            <Fact label="Phone" value={record.phoneE164 ? formatPhone(record.phoneE164) : record.phone} />
            <Fact label="Email" value={record.email} />
            <Fact label="Address" value={record.address} />
            {record.optedOut ? <Text style={styles.warn}>Replied STOP — texting is off. Calling is fine.</Text> : null}
            {error ? <Text style={styles.error}>{error}</Text> : null}
          </>
        )}
      </Section>

      {record.kind === 'lead' && record.lead ? (
        <Section title="Lead">
          <View style={styles.statusRow}>
            {LEAD_STATUS_ORDER.map((s) => {
              const active = record.lead?.status === s;
              return (
                <Pressable
                  key={s}
                  onPress={() => void moveLead(s)}
                  disabled={statusBusy !== null}
                  style={({ pressed }) => [styles.statusChip, active && styles.statusChipActive, pressed && styles.pressed]}>
                  {statusBusy === s ? (
                    <ActivityIndicator size="small" color={colors.ink} />
                  ) : (
                    <Text style={[styles.statusChipText, active && styles.statusChipTextActive]}>{LEAD_STATUS_LABEL[s]}</Text>
                  )}
                </Pressable>
              );
            })}
          </View>
          <Fact label="Source" value={record.lead.source} />
          <Fact label="Estimated value" value={record.lead.estimated_value != null ? money(record.lead.estimated_value) : null} />
          <View style={styles.fact}>
            <Text style={styles.factLabel}>Assigned to</Text>
            <Pressable onPress={() => setRepOpen((v) => !v)} style={styles.repButton}>
              <Text style={[styles.factValue, !repName && styles.factMuted]}>{repName ?? 'Nobody yet'}</Text>
              <Ionicons name={repOpen ? 'chevron-up' : 'chevron-down'} size={14} color={colors.inkSoft} />
            </Pressable>
            {repOpen ? (
              <View style={styles.repList}>
                {reps.map((r) => (
                  <Pressable key={r.email} onPress={() => void assign(r.email)} style={({ pressed }) => [styles.repRow, pressed && styles.pressed]}>
                    <Text style={styles.repRowText}>{r.name}</Text>
                    {rep?.toLowerCase() === r.email.toLowerCase() ? <Ionicons name="checkmark" size={14} color={colors.olive} /> : null}
                  </Pressable>
                ))}
                {rep ? (
                  <Pressable onPress={() => void assign(null)} style={({ pressed }) => [styles.repRow, pressed && styles.pressed]}>
                    <Text style={[styles.repRowText, styles.factMuted]}>Unassign</Text>
                  </Pressable>
                ) : null}
              </View>
            ) : null}
          </View>
          {record.lead.lost_reason ? <Fact label="Lost because" value={record.lead.lost_reason} /> : null}
          <Fact label="Created" value={shortDate(record.lead.created_at)} muted />
        </Section>
      ) : null}

      {record.kind === 'customer' ? (
        <Section
          title={`Jobs${jobs.length ? ` · ${jobs.length}` : ''}`}
          right={
            <Pressable
              onPress={() => router.push({ pathname: '/job-editor', params: { customerId: record.id } } as never)}
              hitSlop={6}
              accessibilityLabel="New job">
              <Ionicons name="add-circle-outline" size={18} color={colors.ocean} />
            </Pressable>
          }>
          {orderedJobs.length === 0 ? (
            <Text style={styles.factMuted}>No jobs yet.</Text>
          ) : (
            orderedJobs.map((j) => {
              const stage = isStage(j.stage) ? j.stage : null;
              const pill = stage ? STAGE_COLORS[stage] : { bg: colors.slateSoft, fg: colors.slateDeep };
              const isCurrent = j.id === current?.id;
              return (
                <Pressable
                  key={j.id}
                  onPress={() => router.push({ pathname: '/job/[id]', params: { id: j.id } })}
                  style={({ pressed }) => [styles.job, isCurrent && styles.jobCurrent, pressed && styles.pressed]}>
                  <View style={styles.jobBody}>
                    <Text style={styles.jobTitle} numberOfLines={1}>
                      {j.job_number ?? j.name}
                      {isCurrent ? <Text style={styles.jobCurrentTag}> · current</Text> : null}
                    </Text>
                    <Text style={styles.jobMeta} numberOfLines={1}>
                      {j.name !== j.job_number ? j.name : ''}
                      {j.scheduled_for ? `${j.name !== j.job_number ? ' · ' : ''}${shortDate(j.scheduled_for)}` : ''}
                    </Text>
                  </View>
                  <Pill label={stage ?? (j.status ?? 'No stage')} bg={pill.bg} fg={pill.fg} />
                </Pressable>
              );
            })
          )}
        </Section>
      ) : null}

      {record.kind === 'customer' && hasMoney && summary ? (
        <Section title="Money">
          <View style={styles.moneyRow}>
            <View style={styles.moneyCell}>
              <Text style={styles.moneyValue}>{money(summary.invoiced)}</Text>
              <Text style={styles.moneyLabel}>Invoiced</Text>
            </View>
            <View style={styles.moneyCell}>
              <Text style={styles.moneyValue}>{money(summary.paid)}</Text>
              <Text style={styles.moneyLabel}>Paid</Text>
            </View>
            <View style={styles.moneyCell}>
              <Text style={[styles.moneyValue, summary.balance > 0 && styles.moneyDue]}>{money(summary.balance)}</Text>
              <Text style={styles.moneyLabel}>Balance</Text>
            </View>
          </View>
        </Section>
      ) : null}

      <Section title="Next up">
        <Fact label="Next scheduled day" value={nextDay ? shortDate(nextDay) : null} muted={!nextDay} />
        <Fact
          label={record.kind === 'lead' ? 'Appointment' : 'Crew on current job'}
          value={
            record.kind === 'lead'
              ? null
              : crew.length
                ? crew.map((a) => a.name).join(', ')
                : current
                  ? null
                  : undefined
          }
          muted
        />
        {record.kind === 'lead' ? (
          <Text style={styles.factMuted}>Pre-sale appointments for leads are a later CRM phase.</Text>
        ) : null}
      </Section>

      <Section title="Tasks">
        <Text style={styles.factMuted}>Follow-up tasks are a later CRM phase — nothing to show yet.</Text>
      </Section>

      {record.kind === 'customer' ? (
        <Section
          title={`Files${docs.length + documents.length ? ` · ${docs.length + documents.length}` : ''}`}
          right={
            <Pressable
              onPress={() => router.push({ pathname: '/crm/[id]', params: { id: record.id, segment: 'documents' } })}
              hitSlop={6}
              accessibilityLabel="All documents">
              <Ionicons name="open-outline" size={15} color={colors.ocean} />
            </Pressable>
          }>
          {docs.length + documents.length === 0 ? (
            <Text style={styles.factMuted}>No documents yet.</Text>
          ) : (
            <>
              {docs.slice(0, 6).map((f) => (
                <View key={f.id} style={styles.file}>
                  <Ionicons name="document-text-outline" size={14} color={colors.inkSoft} />
                  <Text style={styles.fileText} numberOfLines={1}>
                    {f.document_number ?? f.type} · {money(f.amount)}
                  </Text>
                </View>
              ))}
              {documents.slice(0, 4).map((d) => (
                <View key={d.id} style={styles.file}>
                  <Ionicons name="shield-checkmark-outline" size={14} color={colors.inkSoft} />
                  <Text style={styles.fileText} numberOfLines={1}>
                    {d.file_name}
                  </Text>
                </View>
              ))}
            </>
          )}
        </Section>
      ) : null}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  column: { flex: 1, backgroundColor: colors.canvas },
  content: { padding: spacing.md, gap: spacing.md, paddingBottom: spacing.xxl },
  close: { flexDirection: 'row', alignItems: 'center', gap: 4, alignSelf: 'flex-start' },
  closeText: { color: colors.ocean, fontSize: 13, fontWeight: '700' },
  section: { backgroundColor: colors.white, borderRadius: radii.md, padding: spacing.md, gap: spacing.sm },
  sectionHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  sectionTitle: { color: colors.inkSoft, fontSize: 11, fontWeight: '800', letterSpacing: 0.6, textTransform: 'uppercase' },
  fact: { gap: 2 },
  factLabel: { color: colors.inkSoft, fontSize: 11, fontWeight: '600' },
  factValue: { color: colors.ink, fontSize: 14, fontWeight: '600' },
  factMuted: { color: colors.inkSoft, fontWeight: '500', fontSize: 13 },
  warn: { color: colors.coralDeep, fontSize: 12, fontWeight: '700' },
  error: { color: colors.danger, fontSize: 12, fontWeight: '700' },
  form: { gap: spacing.sm },
  input: {
    backgroundColor: colors.canvas,
    borderRadius: radii.sm,
    borderWidth: 1,
    borderColor: colors.line,
    paddingHorizontal: spacing.sm + 2,
    paddingVertical: spacing.sm,
    color: colors.ink,
    fontSize: 14,
    fontWeight: '500',
  },
  formButtons: { flexDirection: 'row', justifyContent: 'flex-end', gap: spacing.sm },
  cancel: { paddingHorizontal: spacing.md, paddingVertical: 6, borderRadius: radii.pill },
  cancelText: { color: colors.inkSoft, fontSize: 13, fontWeight: '700' },
  save: { backgroundColor: colors.sun, paddingHorizontal: spacing.lg, paddingVertical: 6, borderRadius: radii.pill, minWidth: 70, alignItems: 'center' },
  saveText: { color: colors.ink, fontSize: 13, fontWeight: '800' },
  statusRow: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.xs },
  statusChip: { paddingHorizontal: spacing.sm + 2, paddingVertical: 5, borderRadius: radii.pill, backgroundColor: colors.canvas, borderWidth: 1, borderColor: colors.line },
  statusChipActive: { backgroundColor: colors.olive, borderColor: colors.olive },
  statusChipText: { color: colors.inkSoft, fontSize: 12, fontWeight: '700' },
  statusChipTextActive: { color: colors.cream },
  repButton: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  repList: { marginTop: spacing.xs, backgroundColor: colors.canvas, borderRadius: radii.sm, borderWidth: 1, borderColor: colors.line },
  repRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: spacing.sm + 2, paddingVertical: spacing.sm },
  repRowText: { color: colors.ink, fontSize: 13, fontWeight: '600' },
  job: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, paddingVertical: spacing.xs },
  jobCurrent: {},
  jobBody: { flex: 1, gap: 1 },
  jobTitle: { color: colors.ink, fontSize: 13, fontWeight: '700' },
  jobCurrentTag: { color: colors.olive, fontWeight: '800' },
  jobMeta: { color: colors.inkSoft, fontSize: 11, fontWeight: '600' },
  moneyRow: { flexDirection: 'row', gap: spacing.sm },
  moneyCell: { flex: 1, backgroundColor: colors.canvas, borderRadius: radii.sm, padding: spacing.sm, gap: 2 },
  moneyValue: { color: colors.ink, fontSize: 15, fontWeight: '800', fontVariant: ['tabular-nums'] },
  moneyDue: { color: colors.coralDeep },
  moneyLabel: { color: colors.inkSoft, fontSize: 10, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 0.4 },
  file: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs },
  fileText: { flex: 1, color: colors.ink, fontSize: 13, fontWeight: '600' },
  pressed: { opacity: 0.6 },
});
