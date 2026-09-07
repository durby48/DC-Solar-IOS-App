import Ionicons from '@expo/vector-icons/Ionicons';
import { useRouter } from 'expo-router';
import { useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';

import { Pill } from '@/components/ui';
import { colors, radii, spacing } from '@/constants/theme';
import { type CustomerJob } from '@/lib/crm';
import { updateJobStage } from '@/lib/jobs';
import { STAGES, STAGE_COLORS, isStage, type Stage } from '@/lib/stages';

/**
 * The one job that matters right now, as a card at the top of the detail
 * column (Phase 8, 2026-09-07). Before this the current job was a thin
 * "· current" tag on the first of eleven identical rows, and its stage was
 * read-only here — moving it meant leaving for the Pipeline.
 *
 * The stage pill is the control: tap it and the eight stages unfold, tap one
 * and it writes through `updateJobStage` — the same function the Pipeline
 * board calls, so `status`/`completed_on` follow and the Phase 4 trigger logs
 * the transition, which then shows in Activity. Nothing new is written.
 *
 * Twenty's record-detail layout is the reference: one prominent "primary
 * relation" block, facts as label-over-value rows, everything else behind a
 * disclosure. Frappe's deal page does the same with its stage control.
 */
function shortDate(iso: string | null): string {
  if (!iso) return '';
  const [y, m, d] = iso.slice(0, 10).split('-').map(Number);
  if (!y || !m || !d) return iso;
  return new Date(y, m - 1, d).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
}

export function CurrentJobCard({
  job,
  crew,
  nextDay,
  canEdit,
  onChanged,
}: {
  job: CustomerJob;
  /** First names of who is assigned, from `job_assignments`. */
  crew: string[];
  /** Next scheduled day on or after today, if any (from the customer's jobs). */
  nextDay: string | null;
  canEdit: boolean;
  onChanged: () => void;
}) {
  const router = useRouter();
  const [picking, setPicking] = useState(false);
  const [busy, setBusy] = useState<Stage | null>(null);
  const [error, setError] = useState<string | null>(null);

  const stage = isStage(job.stage) ? job.stage : null;
  const pill = stage ? STAGE_COLORS[stage] : { bg: colors.slateSoft, fg: colors.slateDeep };
  const label = job.job_number ?? job.name;

  const move = async (next: Stage) => {
    if (next === stage) {
      setPicking(false);
      return;
    }
    setBusy(next);
    setError(null);
    const result = await updateJobStage(job.id, next);
    setBusy(null);
    if (result.ok) {
      setPicking(false);
      onChanged();
    } else {
      setError(result.message);
    }
  };

  return (
    <View style={styles.card}>
      <View style={styles.head}>
        <Text style={styles.eyebrow}>Current job</Text>
        <Pressable
          onPress={() => router.push({ pathname: '/job/[id]', params: { id: job.id } })}
          hitSlop={6}
          accessibilityLabel="Open job"
          style={({ pressed }) => [styles.open, pressed && styles.pressed]}>
          <Text style={styles.openText}>Open</Text>
          <Ionicons name="chevron-forward" size={13} color={colors.ocean} />
        </Pressable>
      </View>

      <Text style={styles.title} numberOfLines={1}>
        {label}
        {job.name && job.name !== label ? <Text style={styles.titleName}> · {job.name}</Text> : null}
      </Text>
      {job.address ? (
        <Text style={styles.address} numberOfLines={2}>
          {job.address}
        </Text>
      ) : null}

      <Pressable
        onPress={() => canEdit && setPicking((v) => !v)}
        disabled={!canEdit}
        accessibilityLabel={canEdit ? 'Change stage' : undefined}
        style={styles.stageRow}>
        <Pill label={stage ?? (job.status ?? 'No stage')} bg={pill.bg} fg={pill.fg} />
        {canEdit ? <Ionicons name={picking ? 'chevron-up' : 'chevron-down'} size={14} color={colors.inkSoft} /> : null}
        {job.completed_on ? <Text style={styles.stageMeta}>Completed {shortDate(job.completed_on)}</Text> : null}
      </Pressable>

      {picking ? (
        <View style={styles.stageList}>
          {STAGES.map((s) => {
            const c = STAGE_COLORS[s];
            const active = s === stage;
            return (
              <Pressable
                key={s}
                onPress={() => void move(s)}
                disabled={busy !== null}
                style={({ pressed }) => [styles.stageOption, active && styles.stageOptionActive, pressed && styles.pressed]}>
                <View style={[styles.stageDot, { backgroundColor: s === 'Complete' ? c.bg : c.fg }]} />
                <Text style={[styles.stageOptionText, active && styles.stageOptionTextActive]}>{s}</Text>
                {busy === s ? <ActivityIndicator size="small" color={colors.ink} /> : active ? <Ionicons name="checkmark" size={14} color={colors.olive} /> : null}
              </Pressable>
            );
          })}
        </View>
      ) : null}
      {error ? <Text style={styles.error}>{error}</Text> : null}

      <View style={styles.facts}>
        <View style={styles.fact}>
          <Text style={styles.factLabel}>Next day on site</Text>
          <Text style={[styles.factValue, !nextDay && styles.factMuted]}>{nextDay ? shortDate(nextDay) : 'Not scheduled'}</Text>
        </View>
        <View style={styles.fact}>
          <Text style={styles.factLabel}>Crew</Text>
          <Text style={[styles.factValue, crew.length === 0 && styles.factMuted]} numberOfLines={2}>
            {crew.length ? crew.join(', ') : 'Nobody assigned'}
          </Text>
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: colors.white,
    borderRadius: radii.md,
    padding: spacing.md,
    gap: spacing.xs + 2,
    borderLeftWidth: 3,
    borderLeftColor: colors.olive,
  },
  head: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  eyebrow: { color: colors.olive, fontSize: 11, fontWeight: '800', letterSpacing: 0.6, textTransform: 'uppercase' },
  open: { flexDirection: 'row', alignItems: 'center', gap: 2 },
  openText: { color: colors.ocean, fontSize: 12, fontWeight: '800' },
  title: { color: colors.ink, fontSize: 15, fontWeight: '800' },
  titleName: { color: colors.inkSoft, fontWeight: '600', fontSize: 13 },
  address: { color: colors.inkSoft, fontSize: 12, fontWeight: '600', lineHeight: 16 },
  stageRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs, marginTop: 2 },
  stageMeta: { color: colors.inkSoft, fontSize: 11, fontWeight: '600', marginLeft: 'auto' },
  stageList: { backgroundColor: colors.canvas, borderRadius: radii.sm, borderWidth: 1, borderColor: colors.line, paddingVertical: 2 },
  stageOption: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, paddingHorizontal: spacing.sm + 2, paddingVertical: 7 },
  stageOptionActive: { backgroundColor: colors.white },
  stageDot: { width: 8, height: 8, borderRadius: 4 },
  stageOptionText: { flex: 1, color: colors.ink, fontSize: 13, fontWeight: '600' },
  stageOptionTextActive: { fontWeight: '800' },
  error: { color: colors.danger, fontSize: 12, fontWeight: '700' },
  facts: { flexDirection: 'row', gap: spacing.sm, marginTop: 2 },
  fact: { flex: 1, gap: 1 },
  factLabel: { color: colors.inkSoft, fontSize: 10, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 0.4 },
  factValue: { color: colors.ink, fontSize: 13, fontWeight: '700' },
  factMuted: { color: colors.inkSoft, fontWeight: '500' },
  pressed: { opacity: 0.6 },
});
