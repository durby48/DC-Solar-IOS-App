import { useRouter } from 'expo-router';
import { useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import { colors, hubColors, radii, shadows, spacing } from '@/constants/theme';
import { supabase } from '@/lib/supabase';

const COMPANY = 'dc-solar';

/**
 * Sales commission settings (2026-10-06, S4), on the CRM settings screen: the
 * rate (30%), and the pay schedule commission is grouped by (every 14 days
 * from a Monday that matches Gusto). A new rate applies to payments from now
 * on — each commission row keeps the rate it was earned at. Links to the
 * commission report (`/commission`). Admin-only (company_settings RLS).
 */
export function CommissionSettingsCard() {
  const router = useRouter();
  const [rate, setRate] = useState('');
  const [anchor, setAnchor] = useState('');
  const [days, setDays] = useState('');
  const [saved, setSaved] = useState({ rate: '', anchor: '', days: '' });
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);

  useEffect(() => {
    let cancelled = false;
    void supabase
      .from('company_settings')
      .select('commission_rate, pay_period_anchor, pay_period_days')
      .eq('company', COMPANY)
      .maybeSingle()
      .then(({ data }) => {
        if (cancelled) return;
        const row = data as { commission_rate?: number; pay_period_anchor?: string; pay_period_days?: number } | null;
        const next = {
          rate: String(Math.round(Number(row?.commission_rate ?? 0.3) * 10000) / 100),
          anchor: row?.pay_period_anchor ?? '2026-08-04',
          days: String(row?.pay_period_days ?? 14),
        };
        setRate(next.rate);
        setAnchor(next.anchor);
        setDays(next.days);
        setSaved(next);
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const dirty = rate.trim() !== saved.rate || anchor.trim() !== saved.anchor || days.trim() !== saved.days;

  const save = async () => {
    const pct = Number(rate.trim());
    const d = Number(days.trim());
    if (!Number.isFinite(pct) || pct < 0 || pct > 100) {
      setMessage({ kind: 'error', text: 'The rate is a percent from 0 to 100.' });
      return;
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(anchor.trim())) {
      setMessage({ kind: 'error', text: 'The first pay period start is a date like 2026-08-04.' });
      return;
    }
    if (!Number.isInteger(d) || d < 7 || d > 31) {
      setMessage({ kind: 'error', text: 'Days per pay period: 7 to 31.' });
      return;
    }
    setSaving(true);
    setMessage(null);
    const { data, error } = await supabase
      .from('company_settings')
      .update({ commission_rate: pct / 100, pay_period_anchor: anchor.trim(), pay_period_days: d })
      .eq('company', COMPANY)
      .select('company');
    setSaving(false);
    if (error || !data?.length) {
      setMessage({ kind: 'error', text: error?.message ?? 'Not saved — admins only.' });
      return;
    }
    setSaved({ rate: rate.trim(), anchor: anchor.trim(), days: days.trim() });
    setMessage({ kind: 'ok', text: 'Saved. Applies to payments from now on.' });
  };

  return (
    <View style={styles.card}>
      <Text style={styles.title}>Sales commission</Text>
      <Text style={styles.body}>
        Reps earn this share of every plan payment from customers they sold — first year and renewals — in the pay period
        the money comes in. Refunds come off the period they happen in.
      </Text>
      {loading ? (
        <ActivityIndicator color={hubColors.crm.fg} />
      ) : (
        <>
          <View style={styles.inline}>
            <View style={styles.field}>
              <Text style={styles.small}>Rate %</Text>
              <TextInput value={rate} onChangeText={setRate} keyboardType="decimal-pad" style={styles.input} />
            </View>
            <View style={styles.fieldWide}>
              <Text style={styles.small}>A pay period starts</Text>
              <TextInput value={anchor} onChangeText={setAnchor} autoCapitalize="none" style={styles.input} />
            </View>
            <View style={styles.field}>
              <Text style={styles.small}>Days</Text>
              <TextInput value={days} onChangeText={setDays} keyboardType="number-pad" style={styles.input} />
            </View>
          </View>
          {dirty ? (
            <Pressable onPress={() => void save()} disabled={saving} style={({ pressed }) => [styles.save, (pressed || saving) && styles.dim]}>
              {saving ? <ActivityIndicator color={colors.textOnAction} size="small" /> : <Text style={styles.saveText}>Save</Text>}
            </Pressable>
          ) : null}
          <Pressable onPress={() => router.push('/commission' as never)} style={({ pressed }) => [styles.link, pressed && styles.dim]}>
            <Text style={styles.linkText}>Open the commission report →</Text>
          </Pressable>
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
  fieldWide: { flex: 2, gap: 4 },
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
  link: { alignSelf: 'flex-start', paddingVertical: 4 },
  linkText: { color: colors.ocean, fontSize: 13, fontWeight: '800' },
  dim: { opacity: 0.55 },
  ok: { color: colors.olive, fontSize: 12, fontWeight: '700' },
  error: { color: colors.danger, fontSize: 12, fontWeight: '700' },
});
