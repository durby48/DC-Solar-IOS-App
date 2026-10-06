import { useFocusEffect } from 'expo-router';
import { useCallback, useState } from 'react';
import { ActivityIndicator, StyleSheet, TextInput, View } from 'react-native';

import { AppText, Button, Card, ListRow, Screen } from '@/components/ui';
import { colors, hubColors, radii, spacing } from '@/constants/theme';
import { useRole } from '@/lib/role';
import { deleteMyText, fetchSavedTexts, saveMyText, type SavedText } from '@/lib/repSettings';

/**
 * `/saved-texts` (2026-10-06, rep Settings). The company's saved texts
 * (admins write those in CRM Settings) and the rep's OWN, which they add,
 * edit and delete here. Both show up in the "Saved texts" picker when texting
 * someone from the CRM — tapping one fills the message box, never sends.
 * `{{first_name}}`-style blanks fill in the same way company texts do.
 */
export default function SavedTextsScreen() {
  const role = useRole();
  const me = role?.email?.toLowerCase() ?? null;
  const [texts, setTexts] = useState<SavedText[] | null>(null);
  const [editing, setEditing] = useState<{ id?: string; title: string; body: string } | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => setTexts(await fetchSavedTexts()), []);
  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );

  const save = async () => {
    if (!editing) return;
    setBusy(true);
    setError(null);
    const result = await saveMyText(editing);
    setBusy(false);
    if (!result.ok) {
      setError(result.message);
      return;
    }
    setEditing(null);
    await load();
  };

  const remove = async (id: string) => {
    setBusy(true);
    const result = await deleteMyText(id);
    setBusy(false);
    if (!result.ok) setError(result.message);
    setEditing(null);
    await load();
  };

  if (!texts) {
    return (
      <Screen edges={[]}>
        <ActivityIndicator color={hubColors.crm.fg} style={styles.loading} />
      </Screen>
    );
  }
  const mine = texts.filter((t) => t.ownerEmail && t.ownerEmail.toLowerCase() === me);
  const company = texts.filter((t) => !t.ownerEmail);

  return (
    <Screen edges={[]} contentContainerStyle={styles.content}>
      <AppText variant="section" color={colors.textSecondary}>
        My saved texts
      </AppText>
      {editing ? (
        <Card style={styles.editor}>
          <TextInput
            value={editing.title}
            onChangeText={(title) => setEditing({ ...editing, title })}
            placeholder="Name, e.g. Follow up after quote"
            placeholderTextColor={colors.textMuted}
            style={styles.input}
          />
          <TextInput
            value={editing.body}
            onChangeText={(body) => setEditing({ ...editing, body })}
            placeholder="Hi {{first_name}}, just checking in…"
            placeholderTextColor={colors.textMuted}
            multiline
            style={[styles.input, styles.body]}
          />
          <AppText variant="caption" color={colors.textSecondary}>
            {'{{first_name}}'} fills in the person&apos;s first name.
          </AppText>
          <View style={styles.buttons}>
            {editing.id ? (
              <Button label="Delete" variant="ghost" size="sm" disabled={busy} onPress={() => void remove(editing.id as string)} />
            ) : null}
            <View style={styles.flex} />
            <Button label="Cancel" variant="ghost" size="sm" disabled={busy} onPress={() => setEditing(null)} />
            <Button label="Save" size="sm" loading={busy} onPress={() => void save()} />
          </View>
        </Card>
      ) : (
        <Card padded={false}>
          {mine.map((t) => (
            <ListRow
              key={t.id}
              icon="chatbubble-ellipses"
              iconColor={hubColors.crm.fg}
              iconBackground={hubColors.crm.bg}
              title={t.title}
              subtitle={t.body}
              onPress={() => setEditing({ id: t.id, title: t.title, body: t.body })}
              divider
            />
          ))}
          <ListRow icon="add" title="Add a saved text" chevron={false} onPress={() => setEditing({ title: '', body: '' })} />
        </Card>
      )}

      <AppText variant="section" color={colors.textSecondary} style={styles.sectionGap}>
        DC Solar saved texts
      </AppText>
      <Card padded={false}>
        {company.map((t, i) => (
          <View key={t.id}>
            <ListRow
              icon="chatbubbles"
              title={t.title}
              subtitle={open === t.id ? undefined : t.body}
              onPress={() => setOpen(open === t.id ? null : t.id)}
              divider={i < company.length - 1 && open !== t.id}
            />
            {open === t.id ? (
              <AppText variant="body" color={colors.textPrimary} style={styles.full}>
                {t.body}
              </AppText>
            ) : null}
          </View>
        ))}
      </Card>
      <AppText variant="caption" color={colors.textSecondary}>
        All of these appear under &quot;Saved texts&quot; when you text someone from the CRM.
      </AppText>
      {error ? (
        <AppText variant="caption" color={colors.danger}>
          {error}
        </AppText>
      ) : null}
    </Screen>
  );
}

const styles = StyleSheet.create({
  content: { width: '100%', maxWidth: 560, alignSelf: 'center', gap: spacing.sm, paddingBottom: spacing.xl },
  loading: { marginVertical: spacing.xl },
  sectionGap: { marginTop: spacing.md },
  editor: { gap: spacing.sm },
  input: {
    backgroundColor: colors.surfaceSunk,
    borderRadius: radii.sm,
    borderWidth: 1,
    borderColor: colors.border,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm + 2,
    color: colors.textPrimary,
    fontSize: 15,
  },
  body: { minHeight: 100, textAlignVertical: 'top' },
  buttons: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  flex: { flex: 1 },
  full: { paddingHorizontal: spacing.md, paddingBottom: spacing.md },
});
