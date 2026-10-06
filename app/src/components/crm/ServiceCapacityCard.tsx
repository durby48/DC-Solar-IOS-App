import { useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import { colors, hubColors, radii, shadows, spacing } from '@/constants/theme';
import { supabase } from '@/lib/supabase';

const COMPANY = 'dc-solar';

/**
 * How many service visits sales can book in a day (2026-10-06, S2), on the
 * CRM settings screen. The service crew is `service_crew_size` people (2) and
 * does up to `service_visits_per_day` visits (5) — on any day at least that
 * many field crew are free of other jobs. Who counts as field crew is the
 * checkbox on Menu → Employees. Read by `service_availability()`.
 * Admin-only (company_settings RLS).
 */
export function ServiceCapacityCard() {
  const [size, setSize] = useState('');
  const [perDay, setPerDay] = useState('');
  const [saved, setSaved] = useState({ size: '', perDay: '' });
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);

  useEffect(() => {
    let cancelled = false;
    void supabase
      .from('company_settings')
      .select('service_crew_size, service_visits_per_day')
      .eq('company', COMPANY)
      .maybeSingle()
      .then(({ data }) => {
        if (cancelled) return;
        const row = data as { service_crew_size?: number; service_visits_per_day?: number } | null;
        const next = { size: String(row?.service_crew_size ?? 2), perDay: String(row?.service_visits_per_day ?? 5) };
        setSize(next.size);
        setPerDay(next.perDay);
        setSaved(next);
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const dirty = size.trim() !== saved.size || perDay.trim() !== saved.perDay;

  const save = async () => {
    const s = Number(size.trim());
    const p = Number(perDay.trim());
    if (!Number.isInteger(s) || s < 1 || s > 20 || !Number.isInteger(p) || p < 1 || p > 50) {
      setMessage({ kind: 'error', text: 'Crew size 1–20 and visits per day 1–50, whole numbers.' });
      return;
    }
    setSaving(true);
    setMessage(null);
    const { data, error } = await supabase
      .from('company_settings')
      .update({ service_crew_size: s, service_visits_per_day: p })
      .eq('company', COMPANY)
      .select('company');
    setSaving(false);
    if (error || !data?.length) {
      setMessage({ kind: 'error', text: error?.message ?? 'Not saved — admins only.' });
      return;
    }
    setSaved({ size: String(s), perDay: String(p) });
    setMessage({ kind: 'ok', text: 'Saved. Visit spots update right away.' });
  };

  return (
    <View style={styles.card}>
      <Text style={styles.title}>Service crew capacity</Text>
      <Text style={styles.body}>
        On a day when this many field crew are free of other jobs, sales can book up to this many visits. Field crew are
        ticked on Menu → Employees.
      </Text>
      {loading ? (
        <ActivityIndicator color={hubColors.crm.fg} />
      ) : (
        <>
          <View style={styles.inline}>
            <View style={styles.field}>
              <Text style={styles.small}>Crew size</Text>
              <TextInput value={size} onChangeText={setSize} keyboardType="number-pad" style={styles.input} />
            </View>
            <View style={styles.field}>
              <Text style={styles.small}>Visits per day</Text>
              <TextInput value={perDay} onChangeText={setPerDay} keyboardType="number-pad" style={styles.input} />
            </View>
          </View>
          {dirty ? (
            <Pressable onPress={() => void save()} disabled={saving} style={({ pressed }) => [styles.save, (pressed || saving) && styles.dim]}>
              {saving ? <ActivityIndicator color={colors.textOnAction} size="small" /> : <Text style={styles.saveText}>Save</Text>}
            </Pressable>
          ) : null}
        </>
      )}
      {message ? <Text style={message.kind === 'ok' ? styles.ok : styles.error}>{message.text}</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  card: { backgroundColor: colors.surface, borderRadius: radii.md, padding: spacing.md, gap: spacing.xs, ...shadows.card },
  title: { color: hubColors.crm.fg, fontSize: 15, fontWeight: '800' },
  body: { color: colors.inkSoft, fontSize: 13, fontWeight: '500', lineHeight: 19 },
  inline: { flexDirection: 'row', gap: spacing.sm, marginTop: spacing.xs },
  field: { flex: 1, gap: 4 },
  small: { color: colors.inkSoft, fontSize: 11, fontWeight: '800', textTransform: 'uppercase' },
  input: {
    backgroundColor: colors.surfaceSunk,
    borderRadius: radii.sm,
    borderWidth: 1,
    borderColor: colors.line,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm + 2,
    color: colors.ink,
    fontSize: 14,
    fontWeight: '600',
  },
  save: {
    alignSelf: 'flex-start',
    backgroundColor: colors.sun,
    borderRadius: radii.pill,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
    minWidth: 110,
    alignItems: 'center',
  },
  saveText: { color: colors.textOnAction, fontSize: 13, fontWeight: '800' },
  dim: { opacity: 0.55 },
  ok: { color: colors.olive, fontSize: 12, fontWeight: '700' },
  error: { color: colors.danger, fontSize: 12, fontWeight: '700' },
});
