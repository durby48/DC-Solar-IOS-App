import { useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import { colors, hubColors, radii, shadows, spacing } from '@/constants/theme';
import { supabase } from '@/lib/supabase';

const COMPANY = 'dc-solar';

/**
 * The annual service plan's Stripe price (2026-10-05, B2), on the CRM
 * settings screen. `service-visit-done` subscribes a customer to this price
 * when the crew marks their visit done.
 *
 * Stripe prices cannot be edited: changing the amount means adding a NEW
 * price to the product in Stripe and pasting its id here. Customers already
 * on the plan keep the price they started at. A price id is not a secret.
 * Admin-only (company_settings RLS); a viewer's save would match no row.
 */
export function BillingSettingsCard() {
  const [priceId, setPriceId] = useState('');
  const [saved, setSaved] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);

  useEffect(() => {
    let cancelled = false;
    void supabase
      .from('company_settings')
      .select('stripe_annual_price_id')
      .eq('company', COMPANY)
      .maybeSingle()
      .then(({ data }) => {
        if (cancelled) return;
        const value = (data as { stripe_annual_price_id?: string | null } | null)?.stripe_annual_price_id ?? '';
        setPriceId(value);
        setSaved(value);
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const save = async () => {
    const value = priceId.trim();
    if (value && !/^price_[A-Za-z0-9]+$/.test(value)) {
      setMessage({ kind: 'error', text: 'A Stripe price id starts with price_ (copy it from the price in Stripe).' });
      return;
    }
    setSaving(true);
    setMessage(null);
    const { data, error } = await supabase
      .from('company_settings')
      .update({ stripe_annual_price_id: value || null })
      .eq('company', COMPANY)
      .select('company');
    setSaving(false);
    if (error || !data?.length) {
      setMessage({ kind: 'error', text: error?.message ?? 'Not saved — admins only.' });
      return;
    }
    setSaved(value);
    setMessage({ kind: 'ok', text: 'Saved. New plans use this price.' });
  };

  return (
    <View style={styles.card}>
      <Text style={styles.title}>Annual service plan (Stripe)</Text>
      <Text style={styles.body}>
        The price a customer is subscribed to when their visit is marked done. To change the amount, add a new price to
        the plan in Stripe and paste its id here.
      </Text>
      {loading ? (
        <ActivityIndicator color={hubColors.crm.fg} />
      ) : (
        <>
          <TextInput
            value={priceId}
            onChangeText={(v) => {
              setPriceId(v);
              setMessage(null);
            }}
            placeholder="price_…"
            placeholderTextColor={colors.inkSoft}
            autoCapitalize="none"
            autoCorrect={false}
            style={styles.input}
          />
          <Pressable
            onPress={() => void save()}
            disabled={saving || priceId.trim() === saved}
            style={({ pressed }) => [styles.save, (pressed || saving || priceId.trim() === saved) && styles.dim]}>
            {saving ? <ActivityIndicator color={colors.textOnAction} size="small" /> : <Text style={styles.saveText}>Save price</Text>}
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
    marginTop: spacing.sm,
  },
  save: {
    alignSelf: 'flex-start',
    backgroundColor: colors.sun,
    borderRadius: radii.pill,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
    marginTop: spacing.xs,
    minWidth: 110,
    alignItems: 'center',
  },
  saveText: { color: colors.textOnAction, fontSize: 13, fontWeight: '800' },
  dim: { opacity: 0.55 },
  ok: { color: colors.olive, fontSize: 12, fontWeight: '700' },
  error: { color: colors.danger, fontSize: 12, fontWeight: '700' },
});
