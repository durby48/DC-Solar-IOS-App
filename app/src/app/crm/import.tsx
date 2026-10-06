import * as DocumentPicker from 'expo-document-picker';
import { Stack, useRouter } from 'expo-router';
import { useMemo, useState } from 'react';
import Ionicons from '@expo/vector-icons/Ionicons';
import { Pressable, StyleSheet, TextInput, View } from 'react-native';

import { AppText, Button, Card, Chip, Screen } from '@/components/ui';
import { colors, hubColors, radii, spacing } from '@/constants/theme';
import {
  buildRows,
  FIELD_LABEL,
  FIELD_ORDER,
  findHeaderRow,
  guessField,
  runImport,
  type Field,
  type ImportResult,
} from '@/lib/leadImport';
import { useRole } from '@/lib/role';
import { parseSpreadsheet, type Sheet } from '@/lib/spreadsheet';

/**
 * `/crm/import` — Import leads (2026-10-07, admins).
 *
 *   1. Pick an .xlsx or .csv (a computer or the iPhone's Files app).
 *   2. Check the column matches (guessed from the headers; tap to change).
 *   3. Name the batch — it becomes each lead's source, so the batch can be
 *      found or undone later.
 *   4. Preview: how many will be added and why the rest are skipped.
 *   5. Import → Prospects with nobody assigned and "call first" set, waiting
 *      in the CRM's Unassigned list for an admin to hand out.
 *
 * The database re-checks every row and also skips anyone already in the CRM
 * (same phone or email at the same address) — lib/leadImport.ts.
 */
const MIME = [
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'text/csv',
  'text/comma-separated-values',
  'application/vnd.ms-excel',
];

export default function ImportLeadsScreen() {
  const router = useRouter();
  const role = useRole();
  const [fileName, setFileName] = useState<string | null>(null);
  const [rows, setRows] = useState<Sheet | null>(null);
  const [headerIndex, setHeaderIndex] = useState(0);
  const [fields, setFields] = useState<Field[]>([]);
  const [source, setSource] = useState('');
  // Fill in missing details (installer, email, phone) on leads already in the CRM.
  const [update, setUpdate] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ImportResult | null>(null);

  const pick = async () => {
    setError(null);
    setResult(null);
    try {
      const picked = await DocumentPicker.getDocumentAsync({ type: MIME, copyToCacheDirectory: true, multiple: false });
      if (picked.canceled || picked.assets.length === 0) return;
      const asset = picked.assets[0];
      const bytes = new Uint8Array(await (await fetch(asset.uri)).arrayBuffer());
      const sheet = parseSpreadsheet(asset.name ?? 'leads.csv', bytes);
      if (sheet.length < 2) throw new Error('That file has no rows.');
      const h = findHeaderRow(sheet);
      setRows(sheet);
      setHeaderIndex(h);
      setFields(sheet[h].map(guessField));
      setFileName(asset.name ?? 'leads');
      const month = new Date().toLocaleDateString('en-US', { month: 'short', year: 'numeric' });
      setSource(`${(asset.name ?? 'Import').replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ').slice(0, 60)} · ${month}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not read that file.');
    }
  };

  const built = useMemo(() => (rows ? buildRows(rows, headerIndex, fields) : []), [rows, headerIndex, fields]);
  const counts = useMemo(() => {
    const c = { keep: 0, no_contact: 0, duplicate: 0, no_name: 0 };
    for (const r of built) c[r.skip ?? 'keep'] += 1;
    return c;
  }, [built]);
  const hasName = fields.includes('name');
  const hasContact = fields.includes('phone') || fields.includes('email');

  const doImport = async () => {
    setBusy(true);
    setError(null);
    const out = await runImport(source.trim(), built, update);
    setBusy(false);
    if (out.ok) setResult(out.result);
    else setError(out.message);
  };

  if (role && !role.isAdmin) {
    return (
      <Screen edges={[]}>
        <Stack.Screen options={{ title: 'Import leads' }} />
        <AppText variant="body">Admins only.</AppText>
      </Screen>
    );
  }

  return (
    <Screen edges={[]} contentContainerStyle={styles.content}>
      <Stack.Screen options={{ title: 'Import leads' }} />

      {result ? (
        <Card style={styles.card}>
          <AppText variant="title">Added {result.inserted} prospects</AppText>
          <AppText variant="body" color={colors.textSecondary}>
            New ones are unassigned and marked call first.
            {result.updated ? ` ${result.updated} leads already in the CRM got missing details filled in (installer, email, phone).` : ''}
            {result.skippedExisting ? ` ${result.skippedExisting} were already in the CRM with nothing new.` : ''}
            {result.skippedDuplicate ? ` ${result.skippedDuplicate} more duplicates were skipped.` : ''}
          </AppText>
          <Button
            label="Open Unassigned"
            icon="people"
            onPress={() => router.navigate({ pathname: '/workspace', params: { lens: 'unassigned' } } as never)}
          />
          <Button
            label="Import another file"
            variant="ghost"
            onPress={() => {
              setResult(null);
              setRows(null);
              setFileName(null);
            }}
          />
        </Card>
      ) : (
        <>
          <Card style={styles.card}>
            <AppText variant="heading">1. Choose a spreadsheet</AppText>
            <AppText variant="caption" color={colors.textSecondary}>
              Excel (.xlsx) or .csv. The first sheet is read.
            </AppText>
            <Button label={fileName ? `Chosen: ${fileName}` : 'Choose file'} icon="document" variant="secondary" onPress={() => void pick()} />
          </Card>

          {rows ? (
            <>
              <Card style={styles.card}>
                <AppText variant="heading">2. Check the columns</AppText>
                <AppText variant="caption" color={colors.textSecondary}>
                  Header found on row {headerIndex + 1}. Tap to change what a column is. Every Notes column goes into the
                  lead&apos;s notes.
                </AppText>
                {rows[headerIndex].map((header, i) => (
                  <View key={`${i}:${header}`} style={styles.column}>
                    <AppText variant="bodyStrong" numberOfLines={1}>
                      {header || `Column ${i + 1}`}
                    </AppText>
                    <View style={styles.chips}>
                      {FIELD_ORDER.map((f) => (
                        <Chip
                          key={f}
                          label={FIELD_LABEL[f]}
                          tone={f === 'skip' ? 'neutral' : 'ocean'}
                          selected={fields[i] === f}
                          onPress={() => setFields((list) => list.map((x, j) => (j === i ? f : x)))}
                        />
                      ))}
                    </View>
                  </View>
                ))}
              </Card>

              <Card style={styles.card}>
                <AppText variant="heading">3. Name this batch</AppText>
                <AppText variant="caption" color={colors.textSecondary}>
                  Saved as each lead&apos;s source, so you can find this batch later.
                </AppText>
                <TextInput value={source} onChangeText={setSource} style={styles.input} placeholder="KC solar permits · Oct 2026" />
              </Card>

              <Card style={styles.card}>
                <AppText variant="heading">4. Preview</AppText>
                <AppText variant="title" color={hubColors.crm.fg}>
                  {counts.keep} will be added
                </AppText>
                {counts.no_contact ? (
                  <AppText variant="body" color={colors.textSecondary}>
                    – {counts.no_contact} skipped: no phone or email
                  </AppText>
                ) : null}
                {counts.duplicate ? (
                  <AppText variant="body" color={colors.textSecondary}>
                    – {counts.duplicate} skipped: duplicate in this file
                  </AppText>
                ) : null}
                {counts.no_name ? (
                  <AppText variant="body" color={colors.textSecondary}>
                    – {counts.no_name} skipped: no name
                  </AppText>
                ) : null}
                <Pressable
                  onPress={() => setUpdate((v) => !v)}
                  accessibilityRole="checkbox"
                  accessibilityState={{ checked: update }}
                  style={styles.checkRow}>
                  <Ionicons name={update ? 'checkbox' : 'square-outline'} size={18} color={update ? colors.olive : colors.inkSoft} />
                  <AppText variant="caption" color={colors.textPrimary} style={styles.flex}>
                    Fill in missing details on leads already in the CRM — installer, email, phone. Nothing is
                    overwritten. Off: people already in the CRM are just skipped.
                  </AppText>
                </Pressable>
                {fields.includes('installer') ? (
                  <AppText variant="caption" color={colors.textSecondary}>
                    The installer is saved on each lead and added to its notes as &quot;Original installer: …&quot;.
                  </AppText>
                ) : null}
                <View style={styles.sample}>
                  {built
                    .filter((r) => !r.skip)
                    .slice(0, 5)
                    .map((r, i) => (
                      <AppText key={i} variant="caption" color={colors.textPrimary} numberOfLines={1}>
                        {r.name} · {r.phone || r.email} · {r.address}
                      </AppText>
                    ))}
                </View>
                {!hasName || !hasContact ? (
                  <AppText variant="caption" color={colors.danger}>
                    Pick which column is the Name, and at least a Phone or Email column.
                  </AppText>
                ) : null}
                <Button
                  label={update ? `Import ${counts.keep} (new + updates)` : `Import ${counts.keep} as unassigned`}
                  icon="cloud-upload"
                  loading={busy}
                  disabled={!hasName || !hasContact || counts.keep === 0 || !source.trim()}
                  onPress={() => void doImport()}
                />
              </Card>
            </>
          ) : null}
        </>
      )}

      {error ? (
        <AppText variant="caption" color={colors.danger}>
          {error}
        </AppText>
      ) : null}
    </Screen>
  );
}

const styles = StyleSheet.create({
  content: { width: '100%', maxWidth: 760, alignSelf: 'center', gap: spacing.md, paddingBottom: spacing.xl },
  card: { gap: spacing.sm },
  column: { gap: 4, paddingTop: spacing.xs, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.border },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 4 },
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
  checkRow: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing.sm },
  flex: { flex: 1 },
  sample: { gap: 2, padding: spacing.sm, borderRadius: radii.sm, backgroundColor: colors.surfaceSunk },
});
