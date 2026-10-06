import * as Clipboard from 'expo-clipboard';
import { useState, type ComponentProps } from 'react';
import { ActivityIndicator, Linking, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import { NumberDropdown } from '@/components/employees/NumberDropdown';
import { Chip } from '@/components/ui';
import { colors, hubColors, radii, spacing } from '@/constants/theme';
import { sendSms } from '@/lib/comms';
import { inviteEmployee, inviteMessage, type InviteRole } from '@/lib/employeeInvites';

/**
 * The Employees screen's invite pieces (2026-10-05).
 *
 *   InviteEmployeeForm — name, email, role (+ cell, DC Solar number for a
 *                        rep, pay rate for crew) → `employee-access` invite.
 *   LinkPanel          — the setup / reset link with Text it (from the DC
 *                        Solar main number, logged), Copy and Email.
 *
 * No email is sent by the system (no SMTP on this project) — the admin sends
 * the link themselves from here.
 */

const ROLES: { key: InviteRole; label: string; hint: string }[] = [
  { key: 'sales', label: 'Sales', hint: 'Only the CRM, only their own prospects and customers.' },
  { key: 'sales_manager', label: 'Sales manager', hint: 'A rep who runs the team: sees every lead, assigns them, can take one over.' },
  { key: 'viewer', label: 'Crew', hint: 'The field app: schedule, jobs, clock-in.' },
  { key: 'operator', label: 'Operator', hint: 'An admin: everything, including money.' },
];

export function LinkPanel({
  link,
  name,
  email,
  cell,
  kind,
}: {
  link: string;
  name: string;
  email: string;
  cell?: string | null;
  kind: 'invite' | 'reset';
}) {
  const [copied, setCopied] = useState(false);
  const [texting, setTexting] = useState(false);
  const [texted, setTexted] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const message = inviteMessage(name, link, kind);

  return (
    <View style={styles.linkBox}>
      <Text style={styles.label}>{kind === 'reset' ? 'Password reset link' : 'Setup link'} — good for 7 days, works once</Text>
      <Text style={styles.link} numberOfLines={3} selectable>
        {link}
      </Text>
      <View style={styles.chips}>
        {cell ? (
          <Chip
            label={texting ? 'Texting…' : texted ? 'Texted ✓' : 'Text it'}
            tone="ocean"
            icon="chatbubble-outline"
            onPress={
              texting || texted
                ? undefined
                : () => {
                    setTexting(true);
                    setError(null);
                    void sendSms({ to: cell, body: message }).then((r) => {
                      setTexting(false);
                      if (r.ok) setTexted(true);
                      else setError(r.message);
                    });
                  }
            }
          />
        ) : null}
        <Chip
          label={copied ? 'Copied' : 'Copy'}
          tone="ocean"
          icon="copy-outline"
          onPress={() => {
            void Clipboard.setStringAsync(message).then(() => setCopied(true));
          }}
        />
        <Chip
          label="Email"
          tone="ocean"
          icon="mail-outline"
          onPress={() => {
            const subject = encodeURIComponent(kind === 'reset' ? 'Your DC Solar password' : 'Welcome to DC Solar — set up your account');
            Linking.openURL(`mailto:${email}?subject=${subject}&body=${encodeURIComponent(message)}`).catch(() => {});
          }}
        />
      </View>
      {cell ? <Text style={styles.hint}>"Text it" sends from the DC Solar main number to {cell}.</Text> : null}
      {error ? <Text style={styles.error}>{error}</Text> : null}
    </View>
  );
}

export function InviteEmployeeForm({
  canInviteOperator,
  onInvited,
  onClose,
}: {
  canInviteOperator: boolean;
  /** Reload the list once the employee exists. */
  onInvited: () => void;
  onClose: () => void;
}) {
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<InviteRole>('sales');
  const [cell, setCell] = useState('');
  const [number, setNumber] = useState<string | null>(null);
  const [payRate, setPayRate] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [link, setLink] = useState<string | null>(null);

  const submit = async () => {
    setBusy(true);
    setError(null);
    const result = await inviteEmployee({
      name: name.trim(),
      email: email.trim(),
      role,
      cell: cell.trim(),
      number: role === 'sales' || role === 'sales_manager' ? (number ?? '') : '',
      payRate: role === 'viewer' ? payRate.trim() : '',
    });
    setBusy(false);
    if (result.ok) {
      setLink(result.link);
      onInvited();
    } else {
      setError(result.message);
    }
  };

  if (link) {
    return (
      <View style={styles.form}>
        <Text style={styles.done}>{name.trim()} is added as {ROLES.find((r) => r.key === role)?.label}. Send them this link:</Text>
        <LinkPanel link={link} name={name.trim()} email={email.trim()} cell={cell.trim() || null} kind="invite" />
        <Pressable onPress={onClose} style={({ pressed }) => [styles.save, pressed && styles.dim]}>
          <Text style={styles.saveText}>Done</Text>
        </Pressable>
      </View>
    );
  }

  const field = (value: string, set: (v: string) => void, placeholder: string, extra?: Partial<ComponentProps<typeof TextInput>>) => (
    <TextInput
      value={value}
      onChangeText={(v) => {
        set(v);
        setError(null);
      }}
      placeholder={placeholder}
      placeholderTextColor={colors.inkSoft}
      style={styles.input}
      {...extra}
    />
  );

  return (
    <View style={styles.form}>
      {field(name, setName, 'Full name', { autoCapitalize: 'words' })}
      {field(email, setEmail, 'Email (their sign-in)', { autoCapitalize: 'none', keyboardType: 'email-address', autoCorrect: false })}
      <Text style={styles.label}>Role</Text>
      <View style={styles.chips}>
        {ROLES.filter((r) => r.key !== 'operator' || canInviteOperator).map((r) => (
          <Chip key={r.key} label={r.label} tone="olive" selected={role === r.key} onPress={() => setRole(r.key)} />
        ))}
      </View>
      <Text style={styles.hint}>{ROLES.find((r) => r.key === role)?.hint}</Text>
      {field(cell, setCell, 'Their cell (optional — to text them the link)', { keyboardType: 'phone-pad' })}
      {role === 'sales' || role === 'sales_manager' ? (
        <>
          <Text style={styles.label}>Their DC Solar number</Text>
          <NumberDropdown value={number} onChange={setNumber} />
        </>
      ) : null}
      {role === 'viewer' ? field(payRate, setPayRate, 'Pay rate $/hr (optional)', { keyboardType: 'decimal-pad' }) : null}
      {error ? <Text style={styles.error}>{error}</Text> : null}
      <View style={styles.buttons}>
        <Pressable onPress={onClose} style={({ pressed }) => [styles.cancel, pressed && styles.dim]}>
          <Text style={styles.cancelText}>Cancel</Text>
        </Pressable>
        <Pressable onPress={() => void submit()} disabled={busy} style={({ pressed }) => [styles.save, (pressed || busy) && styles.dim]}>
          {busy ? <ActivityIndicator color={colors.textOnAction} size="small" /> : <Text style={styles.saveText}>Add & get link</Text>}
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  form: { gap: spacing.sm },
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
  label: { color: colors.inkSoft, fontSize: 11, fontWeight: '800', textTransform: 'uppercase', letterSpacing: 0.4 },
  hint: { color: colors.inkSoft, fontSize: 12, fontWeight: '500' },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.xs },
  linkBox: { gap: spacing.xs, padding: spacing.sm, borderRadius: radii.sm, backgroundColor: colors.surfaceSunk },
  link: { color: colors.ocean, fontSize: 12, fontWeight: '600' },
  done: { color: hubColors.hr.fg, fontSize: 14, fontWeight: '700' },
  error: { color: colors.danger, fontSize: 12, fontWeight: '700' },
  buttons: { flexDirection: 'row', justifyContent: 'flex-end', alignItems: 'center', gap: spacing.sm },
  cancel: { paddingHorizontal: spacing.md, paddingVertical: 6 },
  cancelText: { color: colors.inkSoft, fontSize: 13, fontWeight: '700' },
  save: { alignSelf: 'flex-end', backgroundColor: colors.sun, borderRadius: radii.pill, paddingHorizontal: spacing.lg, paddingVertical: spacing.sm, minWidth: 120, alignItems: 'center' },
  saveText: { color: colors.textOnAction, fontSize: 13, fontWeight: '800' },
  dim: { opacity: 0.55 },
});
