import { useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import { colors, hubColors, radii, shadows, spacing } from '@/constants/theme';
import {
  fetchServicePlans,
  formatCents,
  parseDollars,
  saveServicePlan,
  type PlanTier,
  type ServicePlan,
} from '@/lib/servicePlans';

/**
 * Service plans (2026-10-06; was the single annual price of B2), on the CRM
 * settings screen: Bronze / Silver / Gold — the yearly amount the rep sees
 * when booking, and the Stripe price `service-visit-done` charges.
 *
 * KEEP THE TWO IN STEP. Stripe prices cannot be edited: to change a plan's
 * amount, add a NEW yearly price to the plan product in Stripe, then paste its
 * id here together with the new amount. Customers already on a plan keep the
 * price they started at. A rep's Custom price needs nothing here — it is made
 * on the same product at charge time. A price id is not a secret.
 * Admin-only (service_plans RLS); anyone else's save matches no row.
 */
export function BillingSettingsCard() {
  const [plans, setPlans] = useState<ServicePlan[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    void fetchServicePlans().then((p) => {
      if (!cancelled) setPlans(p);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <View style={styles.card}>
      <Text style={styles.title}>Service plans (Stripe)</Text>
      <Text style={styles.body}>
        What each plan costs per year, and the Stripe price it charges after the first visit. To change an amount, add a
        new yearly price to the plan in Stripe and paste its id here with the new amount. Reps can also sell a custom
        price; that needs nothing here.
      </Text>
      {plans === null ? (
        <ActivityIndicator color={hubColors.crm.fg} />
      ) : plans.length === 0 ? (
        <Text style={styles.error}>No plans found.</Text>
      ) : (
        plans.map((p) => <PlanRow key={p.tier} plan={p} />)
      )}
    </View>
  );
}

function PlanRow({ plan }: { plan: ServicePlan }) {
  const [amount, setAmount] = useState(String(plan.amountCents / 100));
  const [priceId, setPriceId] = useState(plan.stripePriceId);
  const [includes, setIncludes] = useState(plan.includes ?? '');
  const [saved, setSaved] = useState({
    amount: String(plan.amountCents / 100),
    priceId: plan.stripePriceId,
    includes: plan.includes ?? '',
  });
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);
  const dirty = amount.trim() !== saved.amount || priceId.trim() !== saved.priceId || includes.trim() !== saved.includes.trim();

  const save = async () => {
    const cents = parseDollars(amount);
    const id = priceId.trim();
    if (!cents) {
      setMessage({ kind: 'error', text: 'Enter the yearly amount, e.g. 499.' });
      return;
    }
    if (!/^price_[A-Za-z0-9]+$/.test(id)) {
      setMessage({ kind: 'error', text: 'A Stripe price id starts with price_ (copy it from the price in Stripe).' });
      return;
    }
    setSaving(true);
    setMessage(null);
    const result = await saveServicePlan(plan.tier as PlanTier, {
      amountCents: cents,
      stripePriceId: id,
      includes: includes.trim() || null,
    });
    setSaving(false);
    if (!result.ok) {
      setMessage({ kind: 'error', text: result.message });
      return;
    }
    setSaved({ amount: amount.trim(), priceId: id, includes: includes.trim() });
    setMessage({ kind: 'ok', text: `Saved. New ${plan.label} bookings are ${formatCents(cents)}/yr.` });
  };

  return (
    <View style={styles.row}>
      <Text style={styles.planName}>{plan.label}</Text>
      <View style={styles.inline}>
        <TextInput
          value={amount}
          onChangeText={(v) => {
            setAmount(v);
            setMessage(null);
          }}
          placeholder="499"
          placeholderTextColor={colors.inkSoft}
          keyboardType="decimal-pad"
          style={[styles.input, styles.amount]}
        />
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
          style={[styles.input, styles.flex]}
        />
      </View>
      <TextInput
        value={includes}
        onChangeText={(v) => {
          setIncludes(v);
          setMessage(null);
        }}
        placeholder={"What's included, one per line (reps see this in Plans & prices)"}
        placeholderTextColor={colors.inkSoft}
        multiline
        style={[styles.input, styles.multiline]}
      />
      {dirty ? (
        <Pressable
          onPress={() => void save()}
          disabled={saving}
          style={({ pressed }) => [styles.save, (pressed || saving) && styles.dim]}>
          {saving ? <ActivityIndicator color={colors.textOnAction} size="small" /> : <Text style={styles.saveText}>Save {plan.label}</Text>}
        </Pressable>
      ) : null}
      {message ? <Text style={message.kind === 'ok' ? styles.ok : styles.error}>{message.text}</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  card: { backgroundColor: colors.surface, borderRadius: radii.md, padding: spacing.md, gap: spacing.xs, ...shadows.card },
  title: { color: hubColors.crm.fg, fontSize: 15, fontWeight: '800' },
  body: { color: colors.inkSoft, fontSize: 13, fontWeight: '500', lineHeight: 19 },
  row: { gap: spacing.xs, paddingTop: spacing.sm, borderTopWidth: 1, borderTopColor: colors.line, marginTop: spacing.xs },
  planName: { color: colors.ink, fontSize: 14, fontWeight: '800' },
  inline: { flexDirection: 'row', gap: spacing.xs },
  flex: { flex: 1 },
  amount: { width: 90 },
  multiline: { minHeight: 70, textAlignVertical: 'top' },
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
