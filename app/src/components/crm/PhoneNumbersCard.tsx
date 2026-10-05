import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import { NumberDropdown } from '@/components/employees/NumberDropdown';
import { Chip } from '@/components/ui';
import { colors, hubColors, radii, shadows, spacing } from '@/constants/theme';
import { formatPhone } from '@/lib/comms';
import { supabase } from '@/lib/supabase';

const COMPANY = 'dc-solar';

/**
 * Who each Twilio number belongs to (2026-10-05, B3), on the CRM settings
 * screen. One row of `voice_routes` per number:
 *   • incoming calls to it ring that person (twilio-voice-inbound);
 *   • a SALES REP's number is also their caller ID and texting number, and
 *     texts to it push to them (twilio-voice-outbound / -send-sms / -inbound).
 * The main office number stays with whoever it is assigned to today.
 *
 * A number must first be bought in Twilio, added to the Messaging Service's
 * sender pool (so the A2P campaign covers its texts) and given the same
 * "A call comes in" webhook as the main number — this card only says who it
 * belongs to. Admin-only (voice_routes RLS).
 */

interface Route {
  number_e164: string;
  assigned_to: string;
  label: string | null;
}
interface Person {
  email: string;
  name: string;
  role: string;
}

function toE164(raw: string): string | null {
  const digits = raw.replace(/[^0-9]/g, '');
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  return null;
}

export function PhoneNumbersCard() {
  const [routes, setRoutes] = useState<Route[] | null>(null);
  const [people, setPeople] = useState<Person[]>([]);
  const [editing, setEditing] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [draftNumber, setDraftNumber] = useState<string | null>(null);
  const [draftLabel, setDraftLabel] = useState('');
  const [draftOwner, setDraftOwner] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const [{ data: r }, { data: e }] = await Promise.all([
      supabase.from('voice_routes').select('number_e164, assigned_to, label').eq('company', COMPANY).order('created_at'),
      supabase.from('employees').select('email, display_name, role').eq('company', COMPANY).order('display_name'),
    ]);
    setRoutes((r as Route[] | null) ?? []);
    setPeople(
      ((e as { email: string; display_name: string | null; role: string }[] | null) ?? []).map((p) => ({
        email: p.email,
        name: p.display_name ?? p.email,
        role: p.role,
      })),
    );
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const nameOf = (email: string) => {
    const p = people.find((x) => x.email.toLowerCase() === email.toLowerCase());
    return p ? `${p.name}${p.role === 'sales' ? ' (sales)' : ''}` : email;
  };

  const saveRoute = async (number: string, patch: { assigned_to?: string; label?: string | null }) => {
    setBusy(true);
    setError(null);
    const { data, error: err } = await supabase
      .from('voice_routes')
      .update({ ...patch, updated_at: new Date().toISOString() })
      .eq('number_e164', number)
      .select('number_e164');
    setBusy(false);
    if (err || !data?.length) {
      setError(err?.message ?? 'Not saved — admins only.');
      return;
    }
    setEditing(null);
    await load();
  };

  const addRoute = async () => {
    const e164 = draftNumber ? toE164(draftNumber) : null;
    if (!e164) {
      setError('Pick one of the available numbers.');
      return;
    }
    if (!draftOwner) {
      setError('Pick who the number belongs to.');
      return;
    }
    setBusy(true);
    setError(null);
    const { error: err } = await supabase
      .from('voice_routes')
      .insert({ number_e164: e164, company: COMPANY, assigned_to: draftOwner, label: draftLabel.trim() || null });
    setBusy(false);
    if (err) {
      setError(err.message);
      return;
    }
    setAdding(false);
    setDraftNumber(null);
    setDraftLabel('');
    setDraftOwner(null);
    await load();
  };

  const picker = (selected: string | null, onPick: (email: string) => void) => (
    <View style={styles.chips}>
      {people.map((p) => (
        <Chip
          key={p.email}
          label={p.role === 'sales' ? `${p.name} · sales` : p.name}
          tone="olive"
          selected={selected?.toLowerCase() === p.email.toLowerCase()}
          onPress={() => onPick(p.email)}
        />
      ))}
    </View>
  );

  return (
    <View style={styles.card}>
      <Text style={styles.title}>Phone numbers</Text>
      <Text style={styles.body}>
        Who each DC Solar number belongs to. Calls to a number ring its person; a sales rep's number is also the one their
        calls and texts come from, and texts to it notify them.
      </Text>
      {routes === null ? (
        <ActivityIndicator color={hubColors.crm.fg} />
      ) : (
        routes.map((r) => (
          <View key={r.number_e164} style={styles.row}>
            <View style={styles.rowHead}>
              <Text style={styles.number}>{formatPhone(r.number_e164)}</Text>
              <Text style={styles.label}>{r.label ?? ''}</Text>
            </View>
            {editing === r.number_e164 ? (
              <>
                {picker(r.assigned_to, (email) => void saveRoute(r.number_e164, { assigned_to: email }))}
                <Pressable onPress={() => setEditing(null)} style={({ pressed }) => [styles.link, pressed && styles.dim]}>
                  <Text style={styles.linkText}>Done</Text>
                </Pressable>
              </>
            ) : (
              <Pressable onPress={() => setEditing(r.number_e164)} style={({ pressed }) => [styles.owner, pressed && styles.dim]}>
                <Text style={styles.ownerText}>→ {nameOf(r.assigned_to)}</Text>
                <Text style={styles.linkText}>Change</Text>
              </Pressable>
            )}
          </View>
        ))
      )}

      {adding ? (
        <View style={styles.row}>
          <NumberDropdown value={draftNumber} onChange={setDraftNumber} allowNone={false} />
          <TextInput
            value={draftLabel}
            onChangeText={setDraftLabel}
            placeholder="Label, e.g. Sales rep 2"
            placeholderTextColor={colors.inkSoft}
            style={styles.input}
          />
          <Text style={styles.small}>Belongs to</Text>
          {picker(draftOwner, setDraftOwner)}
          <View style={styles.buttons}>
            <Pressable onPress={() => setAdding(false)} style={({ pressed }) => [styles.link, pressed && styles.dim]}>
              <Text style={styles.linkText}>Cancel</Text>
            </Pressable>
            <Pressable onPress={() => void addRoute()} disabled={busy} style={({ pressed }) => [styles.save, (pressed || busy) && styles.dim]}>
              {busy ? <ActivityIndicator color={colors.textOnAction} size="small" /> : <Text style={styles.saveText}>Add number</Text>}
            </Pressable>
          </View>
        </View>
      ) : (
        <Pressable onPress={() => setAdding(true)} style={({ pressed }) => [styles.link, pressed && styles.dim]}>
          <Text style={styles.linkText}>+ Add a number</Text>
        </Pressable>
      )}
      {error ? <Text style={styles.error}>{error}</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  card: { backgroundColor: colors.surface, borderRadius: radii.md, padding: spacing.md, gap: spacing.xs, ...shadows.card },
  title: { color: hubColors.crm.fg, fontSize: 15, fontWeight: '800' },
  body: { color: colors.inkSoft, fontSize: 13, fontWeight: '500', lineHeight: 19 },
  row: { gap: spacing.xs, paddingVertical: spacing.sm, borderTopWidth: 1, borderTopColor: colors.line },
  rowHead: { flexDirection: 'row', alignItems: 'baseline', gap: spacing.sm },
  number: { color: colors.ink, fontSize: 15, fontWeight: '800' },
  label: { color: colors.inkSoft, fontSize: 12, fontWeight: '600' },
  owner: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  ownerText: { color: colors.ink, fontSize: 13, fontWeight: '600' },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.xs },
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
  small: { color: colors.inkSoft, fontSize: 11, fontWeight: '800', textTransform: 'uppercase', marginTop: spacing.xs },
  buttons: { flexDirection: 'row', justifyContent: 'flex-end', alignItems: 'center', gap: spacing.sm },
  link: { alignSelf: 'flex-start', paddingVertical: 4 },
  linkText: { color: colors.ocean, fontSize: 13, fontWeight: '800' },
  save: { backgroundColor: colors.sun, borderRadius: radii.pill, paddingHorizontal: spacing.lg, paddingVertical: spacing.sm, minWidth: 110, alignItems: 'center' },
  saveText: { color: colors.textOnAction, fontSize: 13, fontWeight: '800' },
  dim: { opacity: 0.55 },
  error: { color: colors.danger, fontSize: 12, fontWeight: '700' },
});
