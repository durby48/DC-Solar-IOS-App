import Ionicons from '@expo/vector-icons/Ionicons';
import { Image } from 'expo-image';
import * as ImagePicker from 'expo-image-picker';
import { Stack } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';

import { DropboxStatusCard, MediaGrid } from '@/components/MediaGrid';
import { accentCycle, colors, radii, shadows, spacing } from '@/constants/theme';
import {
  currentMonthISO,
  deleteEmployeeOfMonth,
  formatMonthLabel,
  listEmployeeOfMonth,
  normalizeMonth,
  shiftMonth,
  upsertEmployeeOfMonth,
  type EmployeeOfMonthEntry,
} from '@/lib/eom';
import { fetchMediaAssets, fetchMediaUrls, type MediaAsset } from '@/lib/media';
import { getRole, type RoleInfo } from '@/lib/role';
import { supabase } from '@/lib/supabase';

/**
 * Admin screen for Employee of the Month.
 *
 * The award is one row per month (see the 2026-08-18 migration) precisely so
 * this screen can exist: Devon adds next month's row and photo without anyone
 * shipping a build.
 *
 * THE PICKER STARTS EMPTY. It used to default to one named employee, which
 * made a standing rule look like it was baked into the app; the admin now
 * chooses from the roster every time, and saving without a choice is refused
 * by `upsertEmployeeOfMonth`.
 *
 * TWO PHOTO SOURCES (2026-08-22). "From this phone" is the original picker.
 * "From Dropbox" is the shared library the sync mirrors into
 * `job-photos/eom/library/…` — Devon drops a photo in a Dropbox folder and it
 * is here, with no upload from anybody's phone at all. Picking from the
 * library COPIES NOTHING: `upsertEmployeeOfMonth({photoPath})` stores the
 * existing path, which is why two months are free to share one photo — and
 * why `deleteEmployeeOfMonth` refuses to remove an `eom/library/*` object.
 * Removing August must never destroy a file Devon still has in Dropbox.
 *
 * The admin gate below is cosmetic. RLS is the real barrier: insert/update/
 * delete on `employee_of_month` require public.is_company_admin('dc-solar').
 */

interface RosterEntry {
  email: string;
  name: string;
}

type PhotoSource = 'device' | 'library';

/** Auth + role with an explicit loading phase (mirrors more/employees.tsx). */
function useGate(): { state: 'loading' | 'out' | 'in'; role: RoleInfo | null } {
  const [state, setState] = useState<'loading' | 'out' | 'in'>('loading');
  const [role, setRole] = useState<RoleInfo | null>(null);
  useEffect(() => {
    let cancelled = false;
    const resolve = async () => {
      const { data } = await supabase.auth.getSession();
      const email = data.session?.user?.email ?? null;
      if (cancelled) return;
      if (!email) {
        setRole(null);
        setState('out');
        return;
      }
      const info = await getRole();
      if (cancelled) return;
      setRole(info);
      setState('in');
    };
    resolve();
    const { data: sub } = supabase.auth.onAuthStateChange(() => {
      if (!cancelled) resolve();
    });
    return () => {
      cancelled = true;
      sub.subscription.unsubscribe();
    };
  }, []);
  return { state, role };
}

function initialsOf(name: string): string {
  return (
    name
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((part) => part[0]?.toUpperCase() ?? '')
      .join('') || '?'
  );
}

function accentFor(seed: string) {
  const hash = [...seed].reduce((acc, ch) => (acc * 31 + ch.charCodeAt(0)) >>> 0, 7);
  return accentCycle[hash % accentCycle.length];
}

export default function EmployeeOfMonthScreen() {
  const gate = useGate();
  const isAdmin = gate.role?.isAdmin ?? false;

  const [listState, setListState] = useState<'loading' | 'ok' | 'unavailable'>('loading');
  const [entries, setEntries] = useState<EmployeeOfMonthEntry[]>([]);
  const [roster, setRoster] = useState<RosterEntry[]>([]);

  // Editor state. `open` doubles as "adding"; editing an existing month just
  // preloads the same form with that month's values.
  const [open, setOpen] = useState(false);
  const [month, setMonth] = useState(currentMonthISO().slice(0, 7));
  const [email, setEmail] = useState('');
  const [caption, setCaption] = useState('');
  const [photoUri, setPhotoUri] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);
  const [deletingMonth, setDeletingMonth] = useState<string | null>(null);

  // Photo source: the phone's library, or the Dropbox-mirrored EOM library.
  const [photoSource, setPhotoSource] = useState<PhotoSource>('device');
  const [libraryAssets, setLibraryAssets] = useState<MediaAsset[]>([]);
  const [libraryUrls, setLibraryUrls] = useState<Map<string, string>>(new Map());
  const [libraryState, setLibraryState] = useState<'loading' | 'ok' | 'unavailable'>('loading');
  const [libraryKey, setLibraryKey] = useState(0);
  const [libraryPick, setLibraryPick] = useState<MediaAsset | null>(null);

  const load = useCallback(async () => {
    const result = await listEmployeeOfMonth();
    if (result.status === 'ok') {
      setEntries(result.entries);
      setListState('ok');
    } else {
      setEntries([]);
      setListState('unavailable');
    }
  }, []);

  useEffect(() => {
    if (gate.state !== 'in' || !isAdmin) return;
    let cancelled = false;
    load();
    // Roster for the employee picker — same source the other admin screens use.
    supabase
      .from('employees')
      .select('email, display_name')
      .eq('is_test', false)
      .order('display_name', { ascending: true })
      .then(({ data, error }) => {
        if (cancelled || error || !data) return;
        setRoster(
          data.map((row) => ({
            email: String(row.email),
            name: (row.display_name as string | null) ?? String(row.email),
          })),
        );
      });
    return () => {
      cancelled = true;
    };
  }, [gate.state, isAdmin, load]);

  /**
   * The Dropbox-mirrored EOM library. Loaded only once the editor is open on
   * the "From Dropbox" tab — a screen most often used to fix a caption should
   * not sign two dozen URLs it may never show.
   */
  useEffect(() => {
    if (!open || photoSource !== 'library' || !isAdmin) return;
    let cancelled = false;
    setLibraryState((prev) => (prev === 'ok' ? prev : 'loading'));
    void (async () => {
      const result = await fetchMediaAssets('eom', { limit: 120 });
      if (cancelled) return;
      if (result.status !== 'ok') {
        setLibraryAssets([]);
        setLibraryUrls(new Map());
        setLibraryState('unavailable');
        return;
      }
      const urls = await fetchMediaUrls(result.assets);
      if (cancelled) return;
      setLibraryAssets(result.assets);
      setLibraryUrls(urls);
      setLibraryState('ok');
    })();
    return () => {
      cancelled = true;
    };
  }, [open, photoSource, isAdmin, libraryKey]);

  const resetForm = useCallback(() => {
    setMonth(currentMonthISO().slice(0, 7));
    setEmail('');
    setCaption('');
    setPhotoUri(null);
    setPhotoSource('device');
    setLibraryPick(null);
  }, []);

  const startEdit = useCallback((entry: EmployeeOfMonthEntry) => {
    setStatus(null);
    setMonth(entry.month.slice(0, 7));
    setEmail(entry.employee_email);
    setCaption(entry.caption ?? '');
    setPhotoUri(null);
    setPhotoSource('device');
    setLibraryPick(null);
    setOpen(true);
  }, []);

  /**
   * Pick this month's photo off the phone. `allowsEditing` with a 4:5 aspect
   * makes the OS crop it to a portrait frame so the card is framed right;
   * `upsertEmployeeOfMonth` compresses it on the way up (`lib/images.ts`).
   */
  const pickPhoto = useCallback(async () => {
    try {
      const result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ['images'],
        allowsEditing: true,
        aspect: [4, 5],
        quality: 0.6,
      });
      if (result.canceled || !result.assets?.length) return;
      setPhotoUri(result.assets[0].uri);
      setLibraryPick(null);
    } catch {
      setStatus({ tone: 'error', text: 'Could not open the photo library.' });
    }
  }, []);

  const chooseSource = useCallback((next: PhotoSource) => {
    setPhotoSource(next);
    // Only one photo can win, so switching tabs drops the other tab's choice
    // rather than leaving an invisible one armed.
    if (next === 'device') setLibraryPick(null);
    else setPhotoUri(null);
  }, []);

  const save = useCallback(async () => {
    setStatus(null);
    const normalized = normalizeMonth(month);
    if (!normalized) {
      setStatus({ tone: 'error', text: 'Use a month in YYYY-MM form, e.g. 2026-08.' });
      return;
    }
    setSaving(true);
    const result = await upsertEmployeeOfMonth({
      month: normalized,
      employeeEmail: email,
      caption,
      photo: photoSource === 'device' ? photoUri : null,
      // No copy: the library file already lives in `job-photos`.
      photoPath: photoSource === 'library' ? (libraryPick?.storagePath ?? null) : null,
    });
    setSaving(false);
    if (result.ok) {
      setStatus({ tone: 'ok', text: `${formatMonthLabel(normalized)} saved.` });
      setOpen(false);
      resetForm();
      await load();
    } else {
      setStatus({ tone: 'error', text: result.message });
    }
  }, [month, email, caption, photoSource, photoUri, libraryPick, load, resetForm]);

  const remove = useCallback(
    async (entry: EmployeeOfMonthEntry) => {
      setStatus(null);
      setDeletingMonth(entry.month);
      const result = await deleteEmployeeOfMonth(entry.month);
      setDeletingMonth(null);
      if (result.ok) {
        setStatus({ tone: 'ok', text: `${formatMonthLabel(entry.month)} removed.` });
        await load();
      } else {
        setStatus({ tone: 'error', text: result.message });
      }
    },
    [load],
  );

  const renderEntry = (entry: EmployeeOfMonthEntry) => {
    const name = entry.employee_name ?? entry.employee_email;
    const accent = accentFor(entry.employee_email);
    return (
      <View key={entry.month} style={styles.entryCard}>
        <Pressable
          onPress={() => startEdit(entry)}
          style={({ pressed }) => [styles.entryRow, pressed && styles.rowPressed]}>
          {entry.photoUrl ? (
            <Image
              source={{ uri: entry.photoUrl }}
              style={styles.thumb}
              contentFit="cover"
              cachePolicy="memory-disk"
              transition={150}
            />
          ) : (
            <View style={[styles.thumb, styles.thumbFallback, { backgroundColor: accent.bg }]}>
              <Text style={[styles.thumbInitials, { color: accent.fg }]}>{initialsOf(name)}</Text>
            </View>
          )}
          <View style={styles.entryBody}>
            <Text style={styles.entryMonth}>{formatMonthLabel(entry.month)}</Text>
            <Text style={styles.entryName}>{name}</Text>
            {entry.caption ? (
              <Text style={styles.entryCaption} numberOfLines={2}>
                {entry.caption}
              </Text>
            ) : null}
            {!entry.photo_path ? <Text style={styles.entryWarn}>No photo yet</Text> : null}
          </View>
          <Ionicons name="create-outline" size={18} color={colors.inkSoft} />
        </Pressable>
        <Pressable
          onPress={() => remove(entry)}
          disabled={deletingMonth === entry.month}
          hitSlop={8}
          style={({ pressed }) => [styles.deleteRow, pressed && styles.rowPressed]}>
          {deletingMonth === entry.month ? (
            <ActivityIndicator color={colors.danger} />
          ) : (
            <Text style={styles.deleteText}>Remove</Text>
          )}
        </Pressable>
      </View>
    );
  };

  return (
    <>
      <Stack.Screen options={{ title: 'Employee of the Month' }} />
      <ScrollView style={styles.screen} contentContainerStyle={styles.container}>
        {gate.state === 'loading' ? (
          <View style={styles.centerCard}>
            <ActivityIndicator color={colors.ocean} />
          </View>
        ) : gate.state === 'out' ? (
          <View style={styles.centerCard}>
            <View style={styles.badge}>
              <Ionicons name="trophy" size={26} color={colors.amberDeep} />
            </View>
            <Text style={styles.promptTitle}>Sign in to manage this</Text>
            <Text style={styles.promptText}>
              Employee of the Month is set by owners and operators.
            </Text>
          </View>
        ) : !isAdmin ? (
          <View style={styles.centerCard}>
            <View style={styles.badge}>
              <Ionicons name="lock-closed" size={26} color={colors.ocean} />
            </View>
            <Text style={styles.promptTitle}>Admins only</Text>
            <Text style={styles.promptText}>
              Everyone sees the card on Today; only owners and operators change it.
            </Text>
          </View>
        ) : (
          <>
            <View style={styles.noteCard}>
              <Ionicons name="information-circle" size={18} color={colors.ocean} />
              <Text style={styles.noteText}>
                One row per month. If a month has no row, the Today card keeps showing the most
                recent one, labelled with the current month.
              </Text>
            </View>

            {status ? (
              <View
                style={[
                  styles.statusCard,
                  status.tone === 'error' ? styles.statusError : styles.statusOk,
                ]}>
                <Text
                  style={[
                    styles.statusText,
                    status.tone === 'error' ? styles.statusTextError : styles.statusTextOk,
                  ]}>
                  {status.text}
                </Text>
              </View>
            ) : null}

            {open ? (
              <View style={styles.formCard}>
                <Text style={styles.formTitle}>{formatMonthLabel(normalizeMonth(month) ?? month)}</Text>

                <Text style={styles.fieldLabel}>Month</Text>
                <View style={styles.monthRow}>
                  <Pressable
                    onPress={() =>
                      setMonth(shiftMonth(normalizeMonth(month) ?? currentMonthISO(), -1).slice(0, 7))
                    }
                    hitSlop={8}
                    style={({ pressed }) => [styles.stepChip, pressed && styles.rowPressed]}>
                    <Text style={styles.stepChipText}>‹ Prev</Text>
                  </Pressable>
                  <TextInput
                    value={month}
                    onChangeText={setMonth}
                    placeholder="2026-08"
                    placeholderTextColor={colors.inkSoft}
                    autoCapitalize="none"
                    autoCorrect={false}
                    style={styles.monthInput}
                  />
                  <Pressable
                    onPress={() =>
                      setMonth(shiftMonth(normalizeMonth(month) ?? currentMonthISO(), 1).slice(0, 7))
                    }
                    hitSlop={8}
                    style={({ pressed }) => [styles.stepChip, pressed && styles.rowPressed]}>
                    <Text style={styles.stepChipText}>Next ›</Text>
                  </Pressable>
                </View>

                <Text style={styles.fieldLabel}>Employee</Text>
                {roster.length === 0 ? (
                  <Text style={styles.hintText}>
                    No employees to pick from — the roster is admin-only and
                    could not be read.
                  </Text>
                ) : (
                  <View style={styles.chipWrap}>
                    {roster.map((person) => {
                      const active =
                        email !== '' && person.email.toLowerCase() === email.toLowerCase();
                      return (
                        <Pressable
                          key={person.email}
                          onPress={() => setEmail(person.email)}
                          style={[styles.personChip, active && styles.personChipActive]}>
                          <Text
                            style={[
                              styles.personChipText,
                              active && styles.personChipTextActive,
                            ]}>
                            {person.name}
                          </Text>
                        </Pressable>
                      );
                    })}
                  </View>
                )}

                <Text style={styles.fieldLabel}>Photo</Text>
                <View style={styles.sourceRow}>
                  {(
                    [
                      { key: 'device' as PhotoSource, label: 'From this phone' },
                      { key: 'library' as PhotoSource, label: 'From Dropbox' },
                    ]
                  ).map((option) => {
                    const active = photoSource === option.key;
                    return (
                      <Pressable
                        key={option.key}
                        onPress={() => chooseSource(option.key)}
                        style={({ pressed }) => [
                          styles.sourceTab,
                          active && styles.sourceTabActive,
                          pressed && styles.rowPressed,
                        ]}>
                        <Text
                          style={[styles.sourceTabText, active && styles.sourceTabTextActive]}>
                          {option.label}
                        </Text>
                      </Pressable>
                    );
                  })}
                </View>

                {photoSource === 'device' ? (
                  <>
                    <View style={styles.photoRow}>
                      {photoUri ? (
                        <Image
                          source={{ uri: photoUri }}
                          style={styles.preview}
                          contentFit="cover"
                        />
                      ) : (
                        <View style={[styles.preview, styles.previewEmpty]}>
                          <Ionicons name="image" size={20} color={colors.inkSoft} />
                        </View>
                      )}
                      <Pressable
                        onPress={pickPhoto}
                        style={({ pressed }) => [
                          styles.secondaryButton,
                          pressed && styles.rowPressed,
                        ]}>
                        <Text style={styles.secondaryButtonText}>
                          {photoUri ? 'Choose a different photo' : 'Choose photo'}
                        </Text>
                      </Pressable>
                    </View>
                    <Text style={styles.hintText}>
                      Leave the photo alone when editing and the existing one is kept.
                    </Text>
                  </>
                ) : (
                  <>
                    <View style={styles.photoRow}>
                      {libraryPick && libraryUrls.get(libraryPick.id) ? (
                        <Image
                          source={{ uri: libraryUrls.get(libraryPick.id) as string }}
                          style={styles.preview}
                          contentFit="cover"
                        />
                      ) : (
                        <View style={[styles.preview, styles.previewEmpty]}>
                          <Ionicons name="images" size={20} color={colors.inkSoft} />
                        </View>
                      )}
                      <View style={styles.libraryHint}>
                        <Text style={styles.hintText}>
                          {libraryPick
                            ? (libraryPick.caption ??
                              libraryPick.fileName ??
                              'Selected from the Dropbox library.')
                            : 'Tap a photo below to use it. Nothing is copied — the file stays where the sync put it.'}
                        </Text>
                      </View>
                    </View>
                    <MediaGrid
                      assets={libraryAssets}
                      urls={libraryUrls}
                      loading={libraryState === 'loading'}
                      scrollable={false}
                      showTagFilter={false}
                      selectedIds={libraryPick ? [libraryPick.id] : undefined}
                      header={
                        <DropboxStatusCard
                          usage="eom"
                          compact
                          onSynced={() => setLibraryKey((n) => n + 1)}
                        />
                      }
                      emptyTitle={
                        libraryState === 'unavailable'
                          ? 'Library unavailable'
                          : 'Nothing in the library yet'
                      }
                      emptyBody={
                        libraryState === 'unavailable'
                          ? 'The photo library needs the latest database migration.'
                          : 'Photos dropped into the EOM folder in Dropbox appear here after the next sync.'
                      }
                      onPress={(index, visible) => {
                        const picked = visible[index] ?? null;
                        setLibraryPick(picked);
                        setPhotoUri(null);
                      }}
                    />
                  </>
                )}

                <Text style={styles.fieldLabel}>Caption (optional)</Text>
                <TextInput
                  value={caption}
                  onChangeText={setCaption}
                  placeholder="Why they earned it"
                  placeholderTextColor={colors.inkSoft}
                  multiline
                  style={styles.captionInput}
                />

                <View style={styles.formActions}>
                  <Pressable
                    onPress={() => {
                      setOpen(false);
                      resetForm();
                    }}
                    disabled={saving}
                    hitSlop={8}>
                    <Text style={styles.cancelText}>Cancel</Text>
                  </Pressable>
                  <Pressable
                    onPress={save}
                    disabled={saving}
                    style={({ pressed }) => [styles.primaryButton, pressed && styles.rowPressed]}>
                    {saving ? (
                      <ActivityIndicator color={colors.white} />
                    ) : (
                      <Text style={styles.primaryButtonText}>Save month</Text>
                    )}
                  </Pressable>
                </View>
              </View>
            ) : (
              <Pressable
                onPress={() => {
                  setStatus(null);
                  resetForm();
                  setOpen(true);
                }}
                style={({ pressed }) => [styles.addButton, pressed && styles.rowPressed]}>
                <Ionicons name="add" size={18} color={colors.white} />
                <Text style={styles.addButtonText}>Add month</Text>
              </Pressable>
            )}

            <Text style={styles.sectionTitle}>Months on record</Text>
            {listState === 'loading' ? (
              <View style={styles.centerCard}>
                <ActivityIndicator color={colors.ocean} />
              </View>
            ) : listState === 'unavailable' ? (
              <View style={styles.centerCard}>
                <Text style={styles.promptText}>
                  Employee of the Month needs the latest database migration.
                </Text>
              </View>
            ) : entries.length === 0 ? (
              <View style={styles.centerCard}>
                <Ionicons name="trophy-outline" size={22} color={colors.inkSoft} />
                <Text style={styles.promptText}>No months yet</Text>
              </View>
            ) : (
              entries.map(renderEntry)
            )}
          </>
        )}
      </ScrollView>
    </>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: colors.cream,
  },
  container: {
    padding: spacing.lg,
    gap: spacing.md,
    paddingBottom: spacing.xxl,
  },
  sectionTitle: {
    color: colors.ink,
    fontSize: 18,
    fontWeight: '700',
    marginTop: spacing.sm,
  },
  centerCard: {
    backgroundColor: colors.skySoft,
    borderRadius: radii.md,
    padding: spacing.lg,
    alignItems: 'center',
    gap: spacing.sm,
  },
  badge: {
    width: 56,
    height: 56,
    borderRadius: radii.lg,
    backgroundColor: colors.white,
    alignItems: 'center',
    justifyContent: 'center',
  },
  promptTitle: {
    color: colors.ink,
    fontSize: 17,
    fontWeight: '800',
    textAlign: 'center',
  },
  promptText: {
    color: colors.inkSoft,
    fontSize: 14,
    fontWeight: '600',
    textAlign: 'center',
  },
  noteCard: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    backgroundColor: colors.skySoft,
    borderRadius: radii.md,
    padding: spacing.md,
  },
  noteText: {
    flex: 1,
    color: colors.inkSoft,
    fontSize: 13,
    fontWeight: '600',
  },
  statusCard: {
    borderRadius: radii.md,
    padding: spacing.md,
  },
  statusOk: { backgroundColor: colors.mintSoft },
  statusError: { backgroundColor: colors.coralSoft },
  statusText: { fontSize: 13, fontWeight: '700' },
  statusTextOk: { color: colors.mintDeep },
  statusTextError: { color: colors.coralDeep },
  addButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.xs,
    backgroundColor: colors.ocean,
    borderRadius: radii.pill,
    paddingVertical: spacing.sm + 4,
  },
  addButtonText: {
    color: colors.white,
    fontSize: 15,
    fontWeight: '800',
  },
  formCard: {
    backgroundColor: colors.white,
    borderRadius: radii.md,
    padding: spacing.md,
    gap: spacing.sm,
    ...shadows.card,
  },
  formTitle: {
    color: colors.ink,
    fontSize: 17,
    fontWeight: '800',
  },
  fieldLabel: {
    color: colors.inkSoft,
    fontSize: 12,
    fontWeight: '800',
    textTransform: 'uppercase',
    letterSpacing: 0.4,
    marginTop: spacing.xs,
  },
  monthRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
  },
  stepChip: {
    backgroundColor: colors.skySoft,
    borderRadius: radii.pill,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs + 2,
  },
  stepChipText: {
    color: colors.ocean,
    fontSize: 13,
    fontWeight: '800',
  },
  monthInput: {
    flex: 1,
    borderWidth: 1,
    borderColor: colors.line,
    borderRadius: radii.sm,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.sm,
    color: colors.ink,
    fontSize: 15,
    fontWeight: '700',
    textAlign: 'center',
  },
  chipWrap: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.xs,
  },
  personChip: {
    borderRadius: radii.pill,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs + 2,
    backgroundColor: colors.white,
    borderWidth: 1,
    borderColor: colors.line,
  },
  personChipActive: {
    backgroundColor: colors.amberSoft,
    borderColor: colors.amberSoft,
  },
  personChipText: {
    color: colors.inkSoft,
    fontSize: 13,
    fontWeight: '700',
  },
  personChipTextActive: {
    color: colors.amberDeep,
    fontWeight: '800',
  },
  sourceRow: {
    flexDirection: 'row',
    backgroundColor: colors.skySoft,
    borderRadius: radii.pill,
    padding: 3,
    gap: 3,
  },
  sourceTab: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radii.pill,
    paddingVertical: spacing.xs + 3,
  },
  sourceTabActive: {
    backgroundColor: colors.white,
    ...shadows.card,
  },
  sourceTabText: {
    color: colors.inkSoft,
    fontSize: 13,
    fontWeight: '800',
  },
  sourceTabTextActive: {
    color: colors.ink,
  },
  libraryHint: {
    flex: 1,
  },
  photoRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
  },
  preview: {
    width: 64,
    height: 80,
    borderRadius: radii.sm,
    backgroundColor: colors.amberSoft,
  },
  previewEmpty: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  secondaryButton: {
    flex: 1,
    alignItems: 'center',
    backgroundColor: colors.skySoft,
    borderRadius: radii.pill,
    paddingVertical: spacing.sm + 2,
  },
  secondaryButtonText: {
    color: colors.ocean,
    fontSize: 14,
    fontWeight: '800',
  },
  hintText: {
    color: colors.inkSoft,
    fontSize: 12,
    fontWeight: '600',
  },
  captionInput: {
    borderWidth: 1,
    borderColor: colors.line,
    borderRadius: radii.sm,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.sm,
    color: colors.ink,
    fontSize: 14,
    minHeight: 64,
    textAlignVertical: 'top',
  },
  formActions: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'flex-end',
    gap: spacing.md,
    marginTop: spacing.sm,
  },
  cancelText: {
    color: colors.inkSoft,
    fontSize: 14,
    fontWeight: '700',
  },
  primaryButton: {
    backgroundColor: colors.ocean,
    borderRadius: radii.pill,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm + 2,
  },
  primaryButtonText: {
    color: colors.white,
    fontSize: 14,
    fontWeight: '800',
  },
  entryCard: {
    backgroundColor: colors.white,
    borderRadius: radii.md,
    overflow: 'hidden',
    ...shadows.card,
  },
  entryRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    padding: spacing.md,
  },
  rowPressed: {
    opacity: 0.85,
  },
  thumb: {
    width: 52,
    height: 64,
    borderRadius: radii.sm,
    backgroundColor: colors.amberSoft,
  },
  thumbFallback: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  thumbInitials: {
    fontSize: 18,
    fontWeight: '800',
  },
  entryBody: {
    flex: 1,
    gap: 2,
  },
  entryMonth: {
    color: colors.amberDeep,
    fontSize: 11,
    fontWeight: '800',
    textTransform: 'uppercase',
    letterSpacing: 0.4,
  },
  entryName: {
    color: colors.ink,
    fontSize: 16,
    fontWeight: '800',
  },
  entryCaption: {
    color: colors.inkSoft,
    fontSize: 13,
    fontWeight: '600',
  },
  entryWarn: {
    color: colors.coralDeep,
    fontSize: 12,
    fontWeight: '700',
  },
  deleteRow: {
    alignItems: 'center',
    paddingVertical: spacing.sm,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.line,
  },
  deleteText: {
    color: colors.danger,
    fontSize: 13,
    fontWeight: '800',
  },
});
