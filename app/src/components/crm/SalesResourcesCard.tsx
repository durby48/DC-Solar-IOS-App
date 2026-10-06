import * as DocumentPicker from 'expo-document-picker';
import { useRouter } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import { colors, hubColors, radii, shadows, spacing } from '@/constants/theme';
import {
  deleteResource,
  fetchResources,
  saveResource,
  uploadResourceFile,
  type ResourceKind,
  type SalesResource,
} from '@/lib/salesResources';

/**
 * Sales resources editor (2026-10-07), on the CRM settings screen — admins
 * only (sales_resources RLS). The brochure PDF (upload / replace / remove),
 * the call script, situations and objections (edit, add, delete). Text uses
 * the same light markup reps see rendered: "# Heading", "## Sub", "- bullet".
 * Changes reach reps immediately; "Preview" opens what they see.
 */
type TextKind = Exclude<ResourceKind, 'file'>;
const KIND_LABEL: Record<TextKind, string> = { script: 'Script', situation: 'Situation', objection: 'Objection' };

export function SalesResourcesCard() {
  const router = useRouter();
  const [items, setItems] = useState<SalesResource[] | null>(null);
  const [editing, setEditing] = useState<{ id?: string; kind: TextKind; title: string; body: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  const load = useCallback(async () => setItems(await fetchResources()), []);
  useEffect(() => {
    void load();
  }, [load]);

  const run = async (fn: () => Promise<{ ok: true } | { ok: false; message: string }>, done: string) => {
    setBusy(true);
    setMessage(null);
    const r = await fn();
    setBusy(false);
    if (!r.ok) {
      setMessage({ ok: false, text: r.message });
      return false;
    }
    setMessage({ ok: true, text: done });
    await load();
    return true;
  };

  const brochure = items?.find((r) => r.kind === 'file') ?? null;

  const upload = async () => {
    const picked = await DocumentPicker.getDocumentAsync({ type: 'application/pdf', copyToCacheDirectory: true, multiple: false });
    if (picked.canceled || picked.assets.length === 0) return;
    const asset = picked.assets[0];
    await run(
      () =>
        uploadResourceFile({
          title: brochure?.title ?? 'DC Solar service plans',
          fileName: asset.name ?? 'brochure.pdf',
          uri: asset.uri,
          contentType: asset.mimeType ?? 'application/pdf',
          replace: brochure,
        }),
      brochure ? 'Brochure replaced.' : 'Brochure uploaded.',
    );
  };

  const row = (r: SalesResource) => (
    <Pressable
      key={r.id}
      onPress={() => setEditing({ id: r.id, kind: r.kind as TextKind, title: r.title, body: r.body ?? '' })}
      style={({ pressed }) => [styles.row, pressed && styles.dim]}>
      <Text style={styles.rowKind}>{KIND_LABEL[r.kind as TextKind]}</Text>
      <Text style={styles.rowTitle} numberOfLines={1}>
        {r.title}
      </Text>
      <Text style={styles.link}>Edit</Text>
    </Pressable>
  );

  return (
    <View style={styles.card}>
      <View style={styles.head}>
        <Text style={styles.title}>Sales resources</Text>
        <Pressable onPress={() => router.push('/resources' as never)} hitSlop={8}>
          <Text style={styles.link}>Preview</Text>
        </Pressable>
      </View>
      <Text style={styles.body}>
        What reps see under Sales resources: the brochure, the call script, situations and objections. Use # for a
        heading, ## for a smaller one, and - for a bullet.
      </Text>

      {items === null ? (
        <ActivityIndicator color={hubColors.crm.fg} />
      ) : editing ? (
        <View style={styles.editor}>
          <Text style={styles.small}>{KIND_LABEL[editing.kind]}</Text>
          <TextInput
            value={editing.title}
            onChangeText={(title) => setEditing({ ...editing, title })}
            placeholder="Title"
            placeholderTextColor={colors.inkSoft}
            style={styles.input}
          />
          <TextInput
            value={editing.body}
            onChangeText={(body) => setEditing({ ...editing, body })}
            placeholder={'# Step\n- What to say'}
            placeholderTextColor={colors.inkSoft}
            multiline
            style={[styles.input, styles.bodyInput]}
          />
          <View style={styles.buttons}>
            {editing.id ? (
              <Pressable
                onPress={() => {
                  const r = items.find((x) => x.id === editing.id);
                  if (r) void run(() => deleteResource(r), 'Deleted.').then((ok) => ok && setEditing(null));
                }}
                disabled={busy}>
                <Text style={styles.danger}>Delete</Text>
              </Pressable>
            ) : null}
            <View style={styles.flex} />
            <Pressable onPress={() => setEditing(null)} disabled={busy}>
              <Text style={styles.link}>Cancel</Text>
            </Pressable>
            <Pressable
              onPress={() =>
                void run(() => saveResource({ id: editing.id, kind: editing.kind, title: editing.title, body: editing.body }), 'Saved — reps see it now.').then(
                  (ok) => ok && setEditing(null),
                )
              }
              disabled={busy}
              style={({ pressed }) => [styles.save, (pressed || busy) && styles.dim]}>
              {busy ? <ActivityIndicator color={colors.textOnAction} size="small" /> : <Text style={styles.saveText}>Save</Text>}
            </Pressable>
          </View>
        </View>
      ) : (
        <>
          <View style={styles.row}>
            <Text style={styles.rowKind}>Brochure</Text>
            <Text style={[styles.rowTitle, !brochure && styles.muted]} numberOfLines={1}>
              {brochure ? brochure.title : 'No PDF yet'}
            </Text>
            <Pressable onPress={() => void upload()} disabled={busy} hitSlop={6}>
              <Text style={styles.link}>{brochure ? 'Replace' : 'Upload PDF'}</Text>
            </Pressable>
          </View>
          {items.filter((r) => r.kind === 'script').map(row)}
          {items.filter((r) => r.kind === 'situation').map(row)}
          {items.filter((r) => r.kind === 'objection').map(row)}
          <View style={styles.addRow}>
            {(['situation', 'objection', 'script'] as TextKind[]).map((k) => (
              <Pressable key={k} onPress={() => setEditing({ kind: k, title: '', body: '' })} style={({ pressed }) => [styles.addChip, pressed && styles.dim]}>
                <Text style={styles.addChipText}>+ {KIND_LABEL[k]}</Text>
              </Pressable>
            ))}
          </View>
        </>
      )}
      {message ? <Text style={message.ok ? styles.ok : styles.error}>{message.text}</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  card: { backgroundColor: colors.surface, borderRadius: radii.md, padding: spacing.md, gap: spacing.xs, ...shadows.card },
  head: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  title: { color: hubColors.crm.fg, fontSize: 15, fontWeight: '800' },
  body: { color: colors.inkSoft, fontSize: 13, fontWeight: '500', lineHeight: 19 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingVertical: spacing.sm,
    borderTopWidth: 1,
    borderTopColor: colors.line,
  },
  rowKind: { color: colors.inkSoft, fontSize: 11, fontWeight: '800', textTransform: 'uppercase', width: 78 },
  rowTitle: { flex: 1, color: colors.ink, fontSize: 14, fontWeight: '700' },
  muted: { color: colors.inkSoft },
  link: { color: colors.ocean, fontSize: 13, fontWeight: '800' },
  danger: { color: colors.danger, fontSize: 13, fontWeight: '800' },
  editor: { gap: spacing.xs },
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
    fontWeight: '500',
  },
  bodyInput: { minHeight: 260, textAlignVertical: 'top', fontFamily: undefined },
  buttons: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  flex: { flex: 1 },
  save: { backgroundColor: colors.sun, borderRadius: radii.pill, paddingHorizontal: spacing.lg, paddingVertical: spacing.sm, minWidth: 90, alignItems: 'center' },
  saveText: { color: colors.textOnAction, fontSize: 13, fontWeight: '800' },
  addRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, paddingTop: spacing.sm, borderTopWidth: 1, borderTopColor: colors.line },
  addChip: { paddingHorizontal: spacing.sm + 2, paddingVertical: 5, borderRadius: radii.pill, backgroundColor: hubColors.crm.bg },
  addChipText: { color: hubColors.crm.deep, fontSize: 12, fontWeight: '700' },
  dim: { opacity: 0.55 },
  ok: { color: colors.olive, fontSize: 12, fontWeight: '700' },
  error: { color: colors.danger, fontSize: 12, fontWeight: '700' },
});
