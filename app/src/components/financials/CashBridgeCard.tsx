import Ionicons from '@expo/vector-icons/Ionicons';
import { useMemo, useState } from 'react';
import { Pressable, StyleSheet, TextInput, View } from 'react-native';

import { AppText, Button, Card, Chip, SectionHeader } from '@/components/ui';
import { colors, hubColors, radii, spacing, typography } from '@/constants/theme';
import { BOOKS_START, OPENING_CASH, payBackOutOfPocket, type CashBridge } from '@/lib/books';
import { formatShortDate, todayISO } from '@/lib/dates';
import { isValidISODate } from '@/lib/time';
import { formatMoney } from './format';

export interface OwedRow {
  id: string;
  occurred_on: string | null;
  label: string;
  /** Whose pocket — from the receipt's method / employee. */
  who: string;
  job: string | null;
  amount: number;
  description: string | null;
  extracted?: Record<string, unknown> | null;
}

const METHODS = ['Venmo', 'Zelle', 'Check', 'Cash', 'Other'] as const;

/**
 * Profit → cash (2026-10-14, Devon): the same walk QuickBooks' Statement of Cash
 * Flows makes, line for line, from the app's own ledger — cash-basis profit since
 * the books start, plus opening balances and owner money in, minus vehicles bought
 * and owner draws, plus what is still owed out of pocket = cash in the accounts.
 * Every figure comes from the rows Financials already loads, and the screen
 * reloads on any finance change (realtime), so paying someone back moves the
 * lines immediately.
 *
 * The owed line opens into the items and a "Pay back" form.
 */
export function CashBridgeCard({ bridge, owed, onChanged }: { bridge: CashBridge; owed: OwedRow[]; onChanged: () => void }) {
  const [open, setOpen] = useState(false);
  const [paying, setPaying] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [paidOn, setPaidOn] = useState(todayISO());
  const [from, setFrom] = useState<'bank' | 'owner'>('bank');
  const [method, setMethod] = useState<(typeof METHODS)[number]>('Venmo');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);

  const chosen = owed.filter((o) => selected.has(o.id));
  const chosenTotal = chosen.reduce((s, o) => s + o.amount, 0);
  const byWho = useMemo(() => {
    const m = new Map<string, number>();
    for (const o of owed) m.set(o.who, (m.get(o.who) ?? 0) + o.amount);
    return [...m.entries()];
  }, [owed]);

  const startPaying = () => {
    setSelected(new Set(owed.map((o) => o.id)));
    setPaidOn(todayISO());
    setMessage(null);
    setPaying(true);
  };

  const toggle = (id: string) =>
    setSelected((cur) => {
      const next = new Set(cur);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const submit = async () => {
    if (!isValidISODate(paidOn.trim())) {
      setMessage({ kind: 'error', text: 'Date must be YYYY-MM-DD.' });
      return;
    }
    setBusy(true);
    const res = await payBackOutOfPocket(chosen, { paidOn: paidOn.trim(), from, method });
    setBusy(false);
    if (!res.ok) {
      setMessage({ kind: 'error', text: res.message });
      return;
    }
    setMessage({
      kind: 'ok',
      text:
        `Recorded ${formatMoney(chosenTotal)} paid back.` +
        (from === 'bank'
          ? res.voidedAlert
            ? ' The Chase alert for it was matched, so it is not counted twice.'
            : ' When the Chase alert for it arrives it is matched automatically.'
          : ' Counted as money you put into the business.'),
    });
    setPaying(false);
    setSelected(new Set());
    onChanged();
  };

  const opening = OPENING_CASH.map((o) => `${o.label.split(' (')[0]} ${formatMoney(o.amount)}`).join(' + ');
  const lines: { label: string; note?: string; amount: number; sign: '' | '+' | '−'; key: string }[] = [
    { key: 'profit', label: `Net profit, cash basis (since ${formatShortDate(BOOKS_START)})`, note: `received ${formatMoney(bridge.income)} − costs ${formatMoney(bridge.expenses)} − payroll ${formatMoney(bridge.payroll)}`, amount: bridge.netProfit, sign: '' },
    { key: 'opening', label: `Starting balances on ${formatShortDate(BOOKS_START)}`, note: opening, amount: bridge.opening, sign: '+' },
    { key: 'ownerIn', label: 'Owner money put in', note: 'investments, and out-of-pocket you paid back personally', amount: bridge.ownerIn, sign: '+' },
    { key: 'assets', label: 'Vehicles & equipment bought', note: 'company property, not an expense', amount: bridge.assets, sign: '−' },
    { key: 'owed', label: 'Out-of-pocket not yet paid back', note: byWho.length ? byWho.map(([w, a]) => `${w} ${formatMoney(a)}`).join(' · ') : 'nobody is owed anything', amount: bridge.owed, sign: '+' },
    { key: 'ownerOut', label: 'Owner draws', note: 'money taken back out', amount: bridge.ownerOut, sign: '−' },
  ];

  return (
    <View style={styles.section}>
      <SectionHeader title="Profit → cash" icon="swap-vertical" accent={hubColors.systems.fg} />
      <Card padded={false}>
        {lines.map((l) => {
          const isOwed = l.key === 'owed';
          return (
            <View key={l.key}>
              <Pressable
                disabled={!isOwed || owed.length === 0}
                onPress={() => setOpen((o) => !o)}
                style={({ pressed }) => [styles.line, pressed && isOwed ? styles.pressed : null]}>
                <View style={styles.flex}>
                  <AppText variant="body">
                    {l.sign ? `${l.sign} ` : ''}
                    {l.label}
                  </AppText>
                  {l.note ? (
                    <AppText variant="caption" color={colors.textMuted}>
                      {l.note}
                      {isOwed && owed.length ? ' · tap for the items' : ''}
                    </AppText>
                  ) : null}
                </View>
                <AppText variant="bodyStrong" style={styles.num}>
                  {l.sign === '−' && l.amount ? '−' : l.sign === '+' && l.amount ? '+' : ''}
                  {formatMoney(Math.abs(l.amount))}
                </AppText>
              </Pressable>

              {isOwed && open ? (
                <View style={styles.owed}>
                  {owed.map((o) => (
                    <Pressable key={o.id} disabled={!paying} onPress={() => toggle(o.id)} style={styles.owedRow}>
                      {paying ? (
                        <Ionicons
                          name={selected.has(o.id) ? 'checkbox' : 'square-outline'}
                          size={18}
                          color={selected.has(o.id) ? colors.olive : colors.textMuted}
                        />
                      ) : null}
                      <AppText variant="caption" color={colors.textMuted} style={styles.date}>
                        {o.occurred_on ? formatShortDate(o.occurred_on) : '—'}
                      </AppText>
                      <AppText variant="caption" color={colors.textSecondary} style={styles.flex} numberOfLines={2}>
                        {o.label}
                        {o.job ? ` · ${o.job}` : ''} · {o.who}
                      </AppText>
                      <AppText variant="caption" style={styles.num}>
                        {formatMoney(o.amount)}
                      </AppText>
                    </Pressable>
                  ))}

                  {paying ? (
                    <View style={styles.form}>
                      <AppText variant="caption" color={colors.textSecondary}>
                        Paid from
                      </AppText>
                      <View style={styles.chips}>
                        <Chip label="Company account (Chase)" tone="olive" selected={from === 'bank'} onPress={() => setFrom('bank')} />
                        <Chip label="Me, personally" tone="olive" selected={from === 'owner'} onPress={() => setFrom('owner')} />
                      </View>
                      <View style={styles.chips}>
                        {METHODS.map((m) => (
                          <Chip key={m} label={m} tone="sun" selected={method === m} onPress={() => setMethod(m)} />
                        ))}
                      </View>
                      <TextInput
                        value={paidOn}
                        onChangeText={setPaidOn}
                        placeholder="YYYY-MM-DD"
                        placeholderTextColor={colors.textMuted}
                        style={styles.input}
                      />
                      <View style={styles.actions}>
                        <Button
                          label={`Paid back ${formatMoney(chosenTotal)}`}
                          size="sm"
                          onPress={() => void submit()}
                          loading={busy}
                          disabled={chosen.length === 0}
                        />
                        <Button label="Cancel" size="sm" variant="ghost" onPress={() => setPaying(false)} />
                      </View>
                    </View>
                  ) : (
                    <Button label="Pay back…" size="sm" variant="secondary" icon="cash-outline" onPress={startPaying} />
                  )}
                </View>
              ) : null}
            </View>
          );
        })}

        <View style={styles.total}>
          <View style={styles.flex}>
            <AppText variant="bodyStrong" color={colors.oliveDeep}>
              = Cash in the accounts
            </AppText>
            <AppText variant="caption" color={colors.textMuted}>
              checking + savings, per the books — same walk as QuickBooks' Statement of Cash Flows
            </AppText>
          </View>
          <AppText variant="numeric">{formatMoney(bridge.cash)}</AppText>
        </View>
        {message ? (
          <AppText variant="caption" color={message.kind === 'ok' ? colors.olive : colors.danger} style={styles.message}>
            {message.text}
          </AppText>
        ) : null}
      </Card>
    </View>
  );
}

const styles = StyleSheet.create({
  section: { marginBottom: spacing.md },
  line: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
  pressed: { opacity: 0.7 },
  flex: { flex: 1, minWidth: 0 },
  num: { fontVariant: ['tabular-nums'] },
  owed: { paddingHorizontal: spacing.md, paddingVertical: spacing.sm, gap: 4, backgroundColor: colors.surface },
  owedRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, paddingVertical: 3 },
  date: { width: 48 },
  form: { gap: spacing.sm, marginTop: spacing.sm },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.xs },
  input: {
    ...typography.body,
    color: colors.textPrimary,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radii.md,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
    maxWidth: 180,
  },
  actions: { flexDirection: 'row', gap: spacing.sm },
  total: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm + 2,
    backgroundColor: colors.oliveTint,
  },
  message: { paddingHorizontal: spacing.md, paddingVertical: spacing.sm },
});
