import Ionicons from '@expo/vector-icons/Ionicons';
import { Stack, useRouter } from 'expo-router';
import { useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';

import { CustomerPicker, type PickedCustomer } from '@/components/contacts/CustomerPicker';
import { TagPicker } from '@/components/contacts/TagPicker';
import {
  deviceContactsSupported,
  readDeviceContacts,
  type DeviceContact,
} from '@/components/contacts/deviceContacts';
import { colors, hubColors, radii, shadows, spacing } from '@/constants/theme';
import { useAdminOnlyScreen } from '@/lib/adminGate';
import { fetchContactTags, importContacts, tagLabel, type ImportSummary } from '@/lib/contacts';

/**
 * Import contacts from the phone — SELECTED ones, never all of them.
 *
 * THREE STEPS ON ONE SCREEN.
 *   pick     read the address book (permission asked once, paged 200 at a
 *            time), search it, tick the ones that belong in the company
 *            directory. Nothing is written yet.
 *   settings tags for the whole selection (existing tags + type a new one),
 *            an optional customer to file them all under ("these five are
 *            Cromwell"), and the summary of what is about to happen.
 *   done     what was inserted, what was updated (a re-import), what was
 *            skipped, and a way back to the Contacts tab.
 *
 * ADMIN ONLY — `useAdminOnlyScreen()` explains and leaves for anyone else;
 * RLS on `contacts` refuses the write regardless. WEB gets one sentence:
 * there is no address book to read in a browser.
 *
 * `expo-contacts` is native. This screen works on build 31 and later; an
 * older binary running newer JS reads "unsupported" from the loader and
 * says so, rather than crashing.
 */

type Step = 'pick' | 'settings' | 'done';

export default function ImportContactsScreen() {
  const gate = useAdminOnlyScreen();
  const router = useRouter();
  const isWeb = Platform.OS === 'web';

  const [step, setStep] = useState<Step>('pick');
  const [reading, setReading] = useState(false);
  const [readError, setReadError] = useState<string | null>(null);
  const [device, setDevice] = useState<DeviceContact[] | null>(null);
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [tags, setTags] = useState<string[]>([]);
  const [existingTags, setExistingTags] = useState<string[]>([]);
  const [customer, setCustomer] = useState<PickedCustomer | null>(null);
  const [importing, setImporting] = useState(false);
  const [result, setResult] = useState<(ImportSummary & { ok: boolean }) | null>(null);

  useEffect(() => {
    if (gate.phase !== 'ready' || !gate.isAdmin) return;
    void fetchContactTags().then(setExistingTags);
  }, [gate.phase, gate.isAdmin]);

  const read = async () => {
    setReading(true);
    setReadError(null);
    const answer = await readDeviceContacts();
    setReading(false);
    if (answer.status === 'ok') {
      setDevice(answer.contacts);
      if (answer.contacts.length === 0) setReadError('Your phone has no contacts to show.');
      return;
    }
    setDevice([]);
    setReadError(
      answer.status === 'denied'
        ? 'Contacts access was declined. Turn it on in Settings → DC Solar → Contacts, then try again.'
        : answer.status === 'unsupported'
          ? 'The address-book import is switched off in this build: the contacts module in build 31 crashed the app at launch, so it is out until Expo ships a fixed version. Contacts can still be added by hand.'
          : answer.message,
    );
  };

  const filtered = useMemo(() => {
    if (!device) return [];
    const q = search.trim().toLowerCase();
    const qDigits = q.replace(/[^0-9]/g, '');
    if (!q) return device;
    return device.filter((c) => {
      if (c.name.toLowerCase().includes(q)) return true;
      if (c.org?.toLowerCase().includes(q)) return true;
      if (c.title?.toLowerCase().includes(q)) return true;
      if (qDigits.length >= 3 && c.phones.some((p) => p.replace(/[^0-9]/g, '').includes(qDigits))) return true;
      return c.emails.some((e) => e.includes(q));
    });
  }, [device, search]);

  const toggle = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const selectShown = () => {
    setSelected((prev) => {
      const next = new Set(prev);
      for (const c of filtered) next.add(c.id);
      return next;
    });
  };

  const chosen = useMemo(() => (device ?? []).filter((c) => selected.has(c.id)), [device, selected]);

  const runImport = async () => {
    if (chosen.length === 0 || importing) return;
    setImporting(true);
    const answer = await importContacts({
      contacts: chosen.map((c) => ({
        externalId: c.id,
        name: c.name,
        org: c.org,
        title: c.title,
        phone: c.phones[0] ?? null,
        email: c.emails[0] ?? null,
      })),
      tags,
      customerId: customer?.id ?? null,
    });
    setImporting(false);
    setResult(answer);
    setStep('done');
    if (answer.ok) {
      setSelected(new Set());
      setExistingTags((prev) => [...new Set([...prev, ...tags])]);
    }
  };

  if (gate.phase === 'loading' || gate.blocked) {
    return (
      <>
        <Stack.Screen options={{ title: 'Import contacts' }} />
        <View style={[styles.screen, styles.center]}>
          {gate.phase === 'loading' ? <ActivityIndicator color={hubColors.crm.fg} /> : null}
        </View>
      </>
    );
  }

  if (isWeb) {
    return (
      <>
        <Stack.Screen options={{ title: 'Import contacts' }} />
        <View style={[styles.screen, styles.center, styles.pad]}>
          <View style={styles.infoCard}>
            <Ionicons name="phone-portrait-outline" size={26} color={hubColors.crm.fg} />
            <Text style={styles.infoTitle}>Import from your phone&apos;s contacts on the iPhone app</Text>
            <Text style={styles.infoBody}>
              A browser cannot read an address book. Open DC Solar on your iPhone → Phone → Contacts →
              Import from phone, tick the people you want, and they will show up here.
            </Text>
            <Pressable onPress={() => router.back()} style={({ pressed }) => [styles.secondary, pressed && styles.pressed]}>
              <Text style={styles.secondaryText}>Back</Text>
            </Pressable>
          </View>
        </View>
      </>
    );
  }

  // ---------------------------------------------------------------- done
  if (step === 'done' && result) {
    return (
      <>
        <Stack.Screen options={{ title: 'Import contacts' }} />
        <ScrollView style={styles.screen} contentContainerStyle={[styles.pad, styles.gap]}>
          <View style={styles.infoCard}>
            <Ionicons
              name={result.ok ? 'checkmark-circle' : 'alert-circle'}
              size={28}
              color={result.ok ? colors.success : colors.danger}
            />
            <Text style={styles.infoTitle}>{result.ok ? 'Imported' : 'The import did not finish'}</Text>
            <Text style={styles.infoBody}>
              {result.inserted} added · {result.updated} updated
              {result.skipped ? ` · ${result.skipped} skipped` : ''}
            </Text>
            {result.message ? <Text style={styles.error}>{result.message}</Text> : null}
            {tags.length ? <Text style={styles.infoBody}>Tagged {tags.map(tagLabel).join(', ')}</Text> : null}
            {customer ? <Text style={styles.infoBody}>Filed under {customer.name}</Text> : null}
          </View>
          <Pressable
            onPress={() => router.replace('/phone/contacts' as never)}
            style={({ pressed }) => [styles.primary, pressed && styles.pressed]}>
            <Text style={styles.primaryText}>Open Contacts</Text>
          </Pressable>
          <Pressable
            onPress={() => {
              setResult(null);
              setStep('pick');
            }}
            style={({ pressed }) => [styles.secondary, pressed && styles.pressed]}>
            <Text style={styles.secondaryText}>Import more</Text>
          </Pressable>
        </ScrollView>
      </>
    );
  }

  // ------------------------------------------------------------ settings
  if (step === 'settings') {
    return (
      <>
        <Stack.Screen options={{ title: 'Import contacts' }} />
        <ScrollView style={styles.screen} contentContainerStyle={[styles.pad, styles.gap]} keyboardShouldPersistTaps="handled">
          <View style={styles.card}>
            <Text style={styles.cardTitle}>Tag {chosen.length === 1 ? 'this contact' : `these ${chosen.length} contacts`}</Text>
            <Text style={styles.hint}>
              What are they to the company? Pick as many as fit, or type your own. Applied to every ticked contact.
            </Text>
            <TagPicker value={tags} onChange={setTags} suggestions={existingTags} accent={hubColors.crm.fg} />
          </View>

          <View style={styles.card}>
            <Text style={styles.cardTitle}>File under a customer</Text>
            <Text style={styles.hint}>
              Optional. A contractor with several people — pick the customer and all of them land on that record.
            </Text>
            <CustomerPicker value={customer} onChange={setCustomer} />
          </View>

          <View style={styles.card}>
            <Text style={styles.cardTitle}>Summary</Text>
            {chosen.slice(0, 8).map((c) => (
              <Text key={c.id} style={styles.summaryRow} numberOfLines={1}>
                • {c.name}
                {c.org ? ` — ${c.org}` : ''}
                {c.phones[0] ? ` · ${c.phones[0]}` : ' · no phone'}
              </Text>
            ))}
            {chosen.length > 8 ? <Text style={styles.hint}>…and {chosen.length - 8} more</Text> : null}
            <Text style={styles.hint}>
              Already in the directory (same phone contact, or same number)? Their row is updated, not duplicated.
              Only the first phone number and email on each card come across.
            </Text>
          </View>

          <Pressable
            onPress={() => void runImport()}
            disabled={importing || chosen.length === 0}
            style={({ pressed }) => [styles.primary, (pressed || importing) && styles.pressed]}>
            {importing ? (
              <ActivityIndicator color={colors.ink} size="small" />
            ) : (
              <Text style={styles.primaryText}>
                Import {chosen.length} {chosen.length === 1 ? 'contact' : 'contacts'}
              </Text>
            )}
          </Pressable>
          <Pressable onPress={() => setStep('pick')} disabled={importing} style={({ pressed }) => [styles.secondary, pressed && styles.pressed]}>
            <Text style={styles.secondaryText}>Back to the list</Text>
          </Pressable>
        </ScrollView>
      </>
    );
  }

  // ---------------------------------------------------------------- pick
  const header = (
    <View style={styles.gap}>
      {device === null ? (
        <View style={styles.card}>
          <Text style={styles.cardTitle}>Pick who belongs in the company directory</Text>
          <Text style={styles.hint}>
            Read your phone&apos;s contacts, tick the ones the crew should have — distributors, drivers,
            inspectors, a contractor&apos;s people — then tag them. Nothing is imported until you say so, and
            never everything at once.
          </Text>
          <Pressable
            onPress={() => void read()}
            disabled={reading}
            style={({ pressed }) => [styles.primary, (pressed || reading) && styles.pressed]}>
            {reading ? (
              <ActivityIndicator color={colors.ink} size="small" />
            ) : (
              <Text style={styles.primaryText}>Read my contacts</Text>
            )}
          </Pressable>
          {!deviceContactsSupported() ? (
            <Text style={styles.hint}>Address-book import is temporarily off (see the note above).</Text>
          ) : null}
          {readError ? <Text style={styles.error}>{readError}</Text> : null}
        </View>
      ) : (
        <>
          <View style={styles.searchRow}>
            <Ionicons name="search" size={16} color={colors.inkSoft} />
            <TextInput
              value={search}
              onChangeText={setSearch}
              placeholder="Search name, company or number"
              placeholderTextColor={colors.inkSoft}
              autoCapitalize="none"
              autoCorrect={false}
              style={styles.searchInput}
            />
            {search ? (
              <Pressable onPress={() => setSearch('')} hitSlop={8}>
                <Ionicons name="close-circle" size={16} color={colors.inkSoft} />
              </Pressable>
            ) : null}
          </View>
          <View style={styles.toolbar}>
            <Text style={styles.toolbarText}>
              {selected.size} selected · {filtered.length} of {device.length} shown
            </Text>
            <View style={styles.toolbarActions}>
              {search.trim() && filtered.length > 0 ? (
                <Pressable onPress={selectShown} hitSlop={6}>
                  <Text style={styles.link}>Select shown</Text>
                </Pressable>
              ) : null}
              {selected.size > 0 ? (
                <Pressable onPress={() => setSelected(new Set())} hitSlop={6}>
                  <Text style={[styles.link, styles.linkMuted]}>Clear</Text>
                </Pressable>
              ) : null}
            </View>
          </View>
          {readError ? <Text style={styles.error}>{readError}</Text> : null}
        </>
      )}
    </View>
  );

  return (
    <>
      <Stack.Screen options={{ title: 'Import contacts' }} />
      <View style={styles.screen}>
        <FlatList
          data={device ? filtered : []}
          keyExtractor={(item) => item.id}
          renderItem={({ item }) => {
            const on = selected.has(item.id);
            const meta = [item.title, item.org].filter(Boolean).join(' · ');
            return (
              <Pressable
                onPress={() => toggle(item.id)}
                accessibilityRole="checkbox"
                accessibilityState={{ checked: on }}
                style={({ pressed }) => [styles.row, on && styles.rowOn, pressed && styles.pressed]}>
                <Ionicons
                  name={on ? 'checkbox' : 'square-outline'}
                  size={22}
                  color={on ? hubColors.crm.fg : colors.inkSoft}
                />
                <View style={styles.rowBody}>
                  <Text style={styles.rowName} numberOfLines={1}>
                    {item.name}
                  </Text>
                  {meta ? (
                    <Text style={styles.rowMeta} numberOfLines={1}>
                      {meta}
                    </Text>
                  ) : null}
                  <Text style={[styles.rowPhone, !item.phones[0] && styles.rowPhoneMissing]} numberOfLines={1}>
                    {item.phones[0] ?? item.emails[0] ?? 'No phone or email'}
                    {item.phones.length > 1 ? `  +${item.phones.length - 1}` : ''}
                  </Text>
                </View>
              </Pressable>
            );
          }}
          ListHeaderComponent={header}
          ItemSeparatorComponent={() => <View style={styles.separator} />}
          contentContainerStyle={styles.list}
          keyboardShouldPersistTaps="handled"
          initialNumToRender={20}
          windowSize={7}
          ListEmptyComponent={
            device && device.length > 0 ? (
              <Text style={styles.empty}>Nobody matches that search.</Text>
            ) : null
          }
        />
        {device && selected.size > 0 ? (
          <View style={styles.footer}>
            <Pressable onPress={() => setStep('settings')} style={({ pressed }) => [styles.primary, pressed && styles.pressed]}>
              <Text style={styles.primaryText}>
                Next · tag {selected.size} {selected.size === 1 ? 'contact' : 'contacts'}
              </Text>
            </Pressable>
          </View>
        ) : null}
      </View>
    </>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.surfaceAlt },
  center: { alignItems: 'center', justifyContent: 'center' },
  pad: { padding: spacing.lg, paddingBottom: spacing.xxl },
  gap: { gap: spacing.sm },
  list: { padding: spacing.lg, paddingBottom: 96 },
  infoCard: {
    backgroundColor: colors.white,
    borderRadius: radii.md,
    padding: spacing.lg,
    alignItems: 'center',
    gap: spacing.sm,
    maxWidth: 480,
    alignSelf: 'center',
    width: '100%',
    ...shadows.card,
  },
  infoTitle: { color: colors.ink, fontSize: 17, fontWeight: '800', textAlign: 'center' },
  infoBody: { color: colors.inkSoft, fontSize: 14, fontWeight: '600', textAlign: 'center' },
  card: {
    backgroundColor: colors.white,
    borderRadius: radii.md,
    padding: spacing.md,
    gap: spacing.sm,
    ...shadows.card,
  },
  cardTitle: { color: colors.ink, fontSize: 15, fontWeight: '800' },
  hint: { color: colors.inkSoft, fontSize: 12, fontWeight: '600', lineHeight: 17 },
  error: { color: colors.danger, fontSize: 13, fontWeight: '700' },
  summaryRow: { color: colors.ink, fontSize: 13, fontWeight: '600' },
  searchRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    backgroundColor: colors.white,
    borderRadius: radii.md,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderWidth: 1,
    borderColor: colors.line,
  },
  searchInput: { flex: 1, color: colors.ink, fontSize: 15, fontWeight: '500', paddingVertical: 4 },
  toolbar: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingBottom: spacing.xs },
  toolbarText: { color: colors.inkSoft, fontSize: 12, fontWeight: '700' },
  toolbarActions: { flexDirection: 'row', gap: spacing.md },
  link: { color: hubColors.crm.fg, fontSize: 12, fontWeight: '800' },
  linkMuted: { color: colors.inkSoft },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    backgroundColor: colors.white,
    borderRadius: radii.md,
    padding: spacing.md,
    borderWidth: 1,
    borderColor: colors.line,
  },
  rowOn: { borderColor: hubColors.crm.fg, backgroundColor: hubColors.crm.bg },
  rowBody: { flex: 1, gap: 1 },
  rowName: { color: colors.ink, fontSize: 15, fontWeight: '700' },
  rowMeta: { color: colors.inkSoft, fontSize: 12, fontWeight: '600' },
  rowPhone: { color: hubColors.crm.fg, fontSize: 12, fontWeight: '700' },
  rowPhoneMissing: { color: colors.inkSoft, fontStyle: 'italic', fontWeight: '600' },
  separator: { height: spacing.xs },
  empty: { color: colors.inkSoft, fontSize: 14, fontWeight: '600', textAlign: 'center', paddingVertical: spacing.lg },
  footer: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    padding: spacing.md,
    paddingBottom: spacing.lg,
    backgroundColor: colors.surfaceAlt,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.line,
  },
  primary: {
    backgroundColor: colors.sun,
    borderRadius: radii.pill,
    paddingVertical: spacing.sm + 4,
    paddingHorizontal: spacing.lg,
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 44,
  },
  primaryText: { color: colors.ink, fontSize: 15, fontWeight: '800' },
  secondary: {
    borderRadius: radii.pill,
    paddingVertical: spacing.sm + 2,
    paddingHorizontal: spacing.lg,
    alignItems: 'center',
    backgroundColor: colors.white,
    borderWidth: 1,
    borderColor: colors.line,
  },
  secondaryText: { color: hubColors.crm.fg, fontSize: 14, fontWeight: '800' },
  pressed: { opacity: 0.6 },
});
