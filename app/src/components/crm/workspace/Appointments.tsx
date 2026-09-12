import Ionicons from '@expo/vector-icons/Ionicons';
import { useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import { Chip } from '@/components/ui';
import { colors, radii, spacing } from '@/constants/theme';
import { authorName } from '@/lib/crmWorkspace';
import {
  APPOINTMENT_KINDS,
  appointmentWhen,
  createLeadAppointment,
  deleteLeadAppointment,
  KIND_LABEL,
  OUTCOME_LABEL,
  setAppointmentOutcome,
  type AppointmentKind,
  type AppointmentOutcome,
  type LeadAppointment,
} from '@/lib/leadAppointments';

/**
 * A lead's pre-sale appointments in the detail panel: one row per meeting
 * ("Site visit · Tue, Sep 9 · 10:00 AM · Devon"), a ⋯ that unfolds the
 * outcome chips and Delete, and an inline composer that asks only what a
 * site visit needs: what kind, which day, what time, who is going.
 *
 * Dates and times are typed (YYYY-MM-DD, HH:MM) rather than picked. The
 * job-day editor on the job screen made the same call for web; a native date
 * picker is a later refinement.
 */

function isoToday(): string {
  const d = new Date();
  return `${d.getFullYear()}-${`${d.getMonth() + 1}`.padStart(2, '0')}-${`${d.getDate()}`.padStart(2, '0')}`;
}

function isoPlusDays(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return `${d.getFullYear()}-${`${d.getMonth() + 1}`.padStart(2, '0')}-${`${d.getDate()}`.padStart(2, '0')}`;
}

export function AppointmentItem({
  appointment,
  reps,
  onChanged,
}: {
  appointment: LeadAppointment;
  reps: { email: string; name: string }[];
  onChanged: () => void;
}) {
  const [menu, setMenu] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const who = appointment.assigned_to
    ? (reps.find((r) => r.email.toLowerCase() === appointment.assigned_to?.toLowerCase())?.name ?? authorName(appointment.assigned_to))
    : null;
  const past = appointment.appt_date < isoToday();
  const resolved = appointment.outcome != null;

  const run = async (action: () => Promise<{ ok: true } | { ok: false; message: string }>) => {
    setBusy(true);
    setError(null);
    const result = await action();
    setBusy(false);
    setMenu(false);
    if (result.ok) onChanged();
    else setError(result.message);
  };

  return (
    <View style={styles.row}>
      <View style={[styles.icon, resolved && styles.iconResolved]}>
        <Ionicons
          name={appointment.kind === 'call' ? 'call-outline' : 'calendar-outline'}
          size={14}
          color={resolved ? colors.inkSoft : colors.violetDeep}
        />
      </View>
      <View style={styles.body}>
        <Text style={[styles.title, resolved && styles.titleResolved]} numberOfLines={2}>
          {KIND_LABEL[appointment.kind] ?? appointment.kind}
          {appointment.outcome ? ` · ${OUTCOME_LABEL[appointment.outcome]}` : ''}
        </Text>
        <Text style={[styles.meta, past && !resolved && styles.overdue]} numberOfLines={1}>
          {appointmentWhen(appointment)}
          {who ? ` · ${who}` : ''}
        </Text>
        {appointment.note ? (
          <Text style={styles.note} numberOfLines={3}>
            {appointment.note}
          </Text>
        ) : null}
        {error ? <Text style={styles.error}>{error}</Text> : null}
        {menu ? (
          <View style={styles.actions}>
            {(Object.keys(OUTCOME_LABEL) as AppointmentOutcome[]).map((o) => (
              <Chip
                key={o}
                label={OUTCOME_LABEL[o]}
                tone={o === 'completed' ? 'olive' : 'neutral'}
                selected={appointment.outcome === o}
                onPress={() => void run(() => setAppointmentOutcome(appointment.id, appointment.outcome === o ? null : o))}
              />
            ))}
            <Chip label="Delete" tone="danger" icon="trash-outline" onPress={() => void run(() => deleteLeadAppointment(appointment.id))} />
          </View>
        ) : null}
      </View>
      <Pressable onPress={() => setMenu((v) => !v)} hitSlop={8} accessibilityLabel="Appointment actions" style={styles.more}>
        {busy ? <ActivityIndicator size="small" color={colors.inkSoft} /> : <Ionicons name={menu ? 'close' : 'ellipsis-horizontal'} size={16} color={colors.inkSoft} />}
      </Pressable>
    </View>
  );
}

export function AppointmentComposer({
  leadId,
  reps,
  myEmail,
  defaultAssignee,
  onAdded,
  onCancel,
}: {
  leadId: string;
  reps: { email: string; name: string }[];
  myEmail: string | null;
  /** The lead's rep, when it has one — the person most likely going. */
  defaultAssignee?: string | null;
  onAdded: () => void;
  onCancel?: () => void;
}) {
  const [kind, setKind] = useState<AppointmentKind>('site_visit');
  const [date, setDate] = useState(isoPlusDays(1));
  const [time, setTime] = useState('');
  const [assignee, setAssignee] = useState<string | null>(defaultAssignee ?? myEmail);
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const others = reps.filter((r) => r.email.toLowerCase() !== myEmail?.toLowerCase());

  const submit = async () => {
    setSaving(true);
    setError(null);
    const result = await createLeadAppointment({
      leadId,
      kind,
      date: date.trim(),
      time: time.trim() || null,
      assignedTo: assignee,
      note,
    });
    setSaving(false);
    if (result.ok) onAdded();
    else setError(result.message);
  };

  return (
    <View style={styles.box}>
      <Text style={styles.label}>What</Text>
      <View style={styles.chips}>
        {APPOINTMENT_KINDS.map((k) => (
          <Chip key={k} label={KIND_LABEL[k]} tone="ocean" selected={kind === k} onPress={() => setKind(k)} />
        ))}
      </View>
      <Text style={styles.label}>When</Text>
      <View style={styles.chips}>
        <Chip label="Tomorrow" tone="ocean" selected={date === isoPlusDays(1)} onPress={() => setDate(isoPlusDays(1))} />
        <Chip label="In 2 days" tone="ocean" selected={date === isoPlusDays(2)} onPress={() => setDate(isoPlusDays(2))} />
        <Chip label="Next week" tone="ocean" selected={date === isoPlusDays(7)} onPress={() => setDate(isoPlusDays(7))} />
      </View>
      <View style={styles.inline}>
        <TextInput
          value={date}
          onChangeText={setDate}
          placeholder="YYYY-MM-DD"
          placeholderTextColor={colors.inkSoft}
          autoCapitalize="none"
          autoCorrect={false}
          style={[styles.input, styles.dateInput]}
        />
        <TextInput
          value={time}
          onChangeText={setTime}
          placeholder="HH:MM (24h) or blank"
          placeholderTextColor={colors.inkSoft}
          autoCapitalize="none"
          autoCorrect={false}
          style={[styles.input, styles.timeInput]}
        />
      </View>
      <Text style={styles.label}>Who is going</Text>
      <View style={styles.chips}>
        {myEmail ? <Chip label="Me" tone="olive" selected={assignee?.toLowerCase() === myEmail.toLowerCase()} onPress={() => setAssignee(myEmail)} /> : null}
        {others.map((r) => (
          <Chip key={r.email} label={r.name} tone="olive" selected={assignee?.toLowerCase() === r.email.toLowerCase()} onPress={() => setAssignee(r.email)} />
        ))}
        <Chip label="Nobody yet" tone="neutral" selected={assignee === null} onPress={() => setAssignee(null)} />
      </View>
      <TextInput
        value={note}
        onChangeText={setNote}
        placeholder="Note — gate code, what to bring…"
        placeholderTextColor={colors.inkSoft}
        style={styles.input}
      />
      {error ? <Text style={styles.error}>{error}</Text> : null}
      <View style={styles.buttons}>
        {onCancel ? (
          <Pressable onPress={onCancel} style={({ pressed }) => [styles.cancel, pressed && styles.pressed]}>
            <Text style={styles.cancelText}>Cancel</Text>
          </Pressable>
        ) : null}
        <Pressable onPress={() => void submit()} disabled={saving} style={({ pressed }) => [styles.save, (pressed || saving) && styles.pressed]}>
          {saving ? <ActivityIndicator color={colors.textOnAction} size="small" /> : <Text style={styles.saveText}>Schedule</Text>}
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing.sm, paddingVertical: spacing.xs + 2 },
  icon: { width: 26, height: 26, borderRadius: 13, backgroundColor: colors.violetSoft, alignItems: 'center', justifyContent: 'center' },
  iconResolved: { backgroundColor: colors.canvas },
  body: { flex: 1, gap: 2 },
  title: { color: colors.ink, fontSize: 13, fontWeight: '700' },
  titleResolved: { color: colors.inkSoft },
  meta: { color: colors.inkSoft, fontSize: 11, fontWeight: '600' },
  overdue: { color: colors.coralDeep, fontWeight: '800' },
  note: { color: colors.inkSoft, fontSize: 12, fontWeight: '500', lineHeight: 16 },
  error: { color: colors.danger, fontSize: 11, fontWeight: '700' },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.xs, marginTop: spacing.xs, padding: spacing.xs, backgroundColor: colors.canvas, borderRadius: radii.sm },
  more: { width: 24, height: 22, alignItems: 'center', justifyContent: 'center' },
  box: { gap: spacing.xs, backgroundColor: colors.canvas, borderRadius: radii.sm, padding: spacing.sm, borderWidth: 1, borderColor: colors.line },
  label: { color: colors.inkSoft, fontSize: 10, fontWeight: '800', letterSpacing: 0.5, textTransform: 'uppercase', marginTop: spacing.xs },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.xs },
  inline: { flexDirection: 'row', gap: spacing.xs },
  input: {
    backgroundColor: colors.surface,
    borderRadius: radii.sm,
    borderWidth: 1,
    borderColor: colors.line,
    paddingHorizontal: spacing.sm + 2,
    paddingVertical: spacing.sm,
    color: colors.ink,
    fontSize: 14,
    fontWeight: '500',
  },
  dateInput: { flex: 1 },
  timeInput: { flex: 1 },
  buttons: { flexDirection: 'row', justifyContent: 'flex-end', alignItems: 'center', gap: spacing.sm, marginTop: spacing.xs },
  cancel: { paddingHorizontal: spacing.md, paddingVertical: 6, borderRadius: radii.pill },
  cancelText: { color: colors.inkSoft, fontSize: 13, fontWeight: '700' },
  save: { backgroundColor: colors.sun, paddingHorizontal: spacing.lg, paddingVertical: 6, borderRadius: radii.pill, minWidth: 90, alignItems: 'center' },
  saveText: { color: colors.textOnAction, fontSize: 13, fontWeight: '800' },
  pressed: { opacity: 0.6 },
});
