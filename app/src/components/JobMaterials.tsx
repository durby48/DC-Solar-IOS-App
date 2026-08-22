import Ionicons from '@expo/vector-icons/Ionicons';
import * as DocumentPicker from 'expo-document-picker';
import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, StyleSheet, TextInput, View } from 'react-native';

import {
  AnimatedPressable,
  AppText,
  Button,
  Card,
  EmptyState,
  FadeInUp,
  Pill,
  SectionHeader,
  SkeletonList,
} from '@/components/ui';
import { colors, radii, spacing, typography } from '@/constants/theme';
import { haptics } from '@/lib/haptics';
import {
  fetchJobDocuments,
  getDocumentUrl,
  uploadJobDocument,
  type JobDocument,
} from '@/lib/data';
import {
  addMaterials,
  deleteMaterial,
  extractMaterialsFromPdf,
  fetchJobMaterials,
  updateMaterial,
  type ExtractedItem,
  type MaterialRow,
} from '@/lib/materials';
import { viewDocument } from '@/lib/pdf';

interface ReviewItem extends ExtractedItem {
  checked: boolean;
}

function formatQty(qty: number): string {
  return Number.isInteger(qty) ? `${qty}` : qty.toLocaleString('en-US', { maximumFractionDigits: 2 });
}

/**
 * Materials section for a job: the itemized parts list (name × qty, no
 * pricing), plus uploaded materials PDFs with a heuristic line-item
 * extractor (extract-materials edge function) whose results are reviewed
 * before saving. Crew sees the list read-only; admins manage everything.
 *
 * 2026-08-22 restyle: kit primitives only — `Card`, `Pill` for the quantity
 * badge, `Button` for every action, `EmptyState` for the three nothing-here
 * cases and `SkeletonList` for the first load. The extraction review flow,
 * the two-tap delete and the admin gating are unchanged.
 */
export function JobMaterials({ jobId, isAdmin }: { jobId: string; isAdmin: boolean }) {
  const [materials, setMaterials] = useState<MaterialRow[]>([]);
  const [docs, setDocs] = useState<JobDocument[]>([]);
  const [state, setState] = useState<'loading' | 'ok' | 'unavailable'>('loading');
  const [status, setStatus] = useState<{ kind: 'success' | 'error'; message: string } | null>(
    null,
  );

  // Manual add form.
  const [addOpen, setAddOpen] = useState(false);
  const [newName, setNewName] = useState('');
  const [newQty, setNewQty] = useState('1');
  const [savingAdd, setSavingAdd] = useState(false);

  // Inline row editing + two-tap delete.
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState('');
  const [editQty, setEditQty] = useState('');
  const [savingEdit, setSavingEdit] = useState(false);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  // PDF upload + extraction review.
  const [uploading, setUploading] = useState(false);
  const [extractingId, setExtractingId] = useState<string | null>(null);
  const [review, setReview] = useState<{ doc: JobDocument; items: ReviewItem[] } | null>(null);
  const [savingReview, setSavingReview] = useState(false);

  const load = useCallback(async () => {
    const [materialsResult, docsResult] = await Promise.all([
      fetchJobMaterials(jobId),
      fetchJobDocuments(jobId),
    ]);
    if (materialsResult.status === 'ok') {
      setMaterials(materialsResult.materials);
      setState('ok');
    } else {
      setMaterials([]);
      setState('unavailable');
    }
    setDocs(
      docsResult.status === 'ok'
        ? docsResult.documents.filter((d) => d.doc_type === 'materials')
        : [],
    );
  }, [jobId]);

  useEffect(() => {
    load();
  }, [load]);

  const saveAdd = async () => {
    const name = newName.trim();
    const qty = Number(newQty.replace(/[^0-9.]/g, ''));
    if (!name) {
      setStatus({ kind: 'error', message: 'Give the item a name.' });
      return;
    }
    if (!Number.isFinite(qty) || qty <= 0) {
      setStatus({ kind: 'error', message: 'Enter a quantity greater than zero.' });
      return;
    }
    setSavingAdd(true);
    setStatus(null);
    const result = await addMaterials({ jobId, items: [{ name, qty }] });
    setSavingAdd(false);
    if (result.ok) {
      setNewName('');
      setNewQty('1');
      setAddOpen(false);
      haptics.success();
      await load();
    } else {
      setStatus({ kind: 'error', message: result.message });
    }
  };

  const startEdit = (row: MaterialRow) => {
    setStatus(null);
    setConfirmDeleteId(null);
    setEditingId(row.id);
    setEditName(row.name);
    setEditQty(String(row.qty));
  };

  const saveEdit = async (row: MaterialRow) => {
    const name = editName.trim();
    const qty = Number(editQty.replace(/[^0-9.]/g, ''));
    if (!name || !Number.isFinite(qty) || qty <= 0) {
      setStatus({ kind: 'error', message: 'Enter a name and a quantity greater than zero.' });
      return;
    }
    setSavingEdit(true);
    setStatus(null);
    const result = await updateMaterial(row.id, { name, qty });
    setSavingEdit(false);
    if (result.ok) {
      setEditingId(null);
      haptics.success();
      await load();
    } else {
      setStatus({ kind: 'error', message: result.message });
    }
  };

  const pressDelete = async (row: MaterialRow) => {
    if (confirmDeleteId !== row.id) {
      setStatus(null);
      setConfirmDeleteId(row.id);
      return;
    }
    setConfirmDeleteId(null);
    setDeletingId(row.id);
    const result = await deleteMaterial(row.id);
    setDeletingId(null);
    if (result.ok) {
      if (editingId === row.id) setEditingId(null);
      await load();
    } else {
      setStatus({ kind: 'error', message: result.message });
    }
  };

  const pickAndUpload = async () => {
    setStatus(null);
    try {
      const result = await DocumentPicker.getDocumentAsync({
        type: 'application/pdf',
        copyToCacheDirectory: true,
        multiple: false,
      });
      if (result.canceled || result.assets.length === 0) return;
      const asset = result.assets[0];
      setUploading(true);
      const upload = await uploadJobDocument({
        jobId,
        docType: 'materials',
        fileName: asset.name ?? 'materials.pdf',
        uri: asset.uri,
        contentType: asset.mimeType ?? 'application/pdf',
      });
      setUploading(false);
      if (upload.ok) {
        haptics.success();
        setStatus({
          kind: 'success',
          message: `${upload.document.file_name} uploaded — tap Extract to pull its line items.`,
        });
        await load();
      } else {
        setStatus({ kind: 'error', message: upload.message });
      }
    } catch (e) {
      setUploading(false);
      setStatus({
        kind: 'error',
        message: e instanceof Error ? e.message : 'Could not upload the PDF.',
      });
    }
  };

  const openDoc = async (doc: JobDocument) => {
    const url = await getDocumentUrl(doc.storage_path);
    if (!url || !(await viewDocument(url))) {
      setStatus({ kind: 'error', message: 'Could not open the PDF. Please try again.' });
    }
  };

  const runExtract = async (doc: JobDocument) => {
    setStatus(null);
    setReview(null);
    setExtractingId(doc.id);
    const result = await extractMaterialsFromPdf(doc.storage_path);
    setExtractingId(null);
    if (!result.ok) {
      setStatus({ kind: 'error', message: `Extraction failed: ${result.message}` });
      return;
    }
    if (result.items.length === 0) {
      setStatus({
        kind: 'error',
        message: 'No line items could be found in that PDF. Add the items manually.',
      });
      return;
    }
    setReview({
      doc,
      items: result.items.map((item) => ({ ...item, checked: true })),
    });
  };

  const saveReview = async () => {
    if (!review) return;
    const chosen = review.items.filter((item) => item.checked);
    if (chosen.length === 0) {
      setStatus({ kind: 'error', message: 'Select at least one item to add.' });
      return;
    }
    setSavingReview(true);
    setStatus(null);
    const result = await addMaterials({
      jobId,
      items: chosen.map(({ name, qty }) => ({ name, qty })),
      sourceDocumentId: review.doc.id,
    });
    setSavingReview(false);
    if (result.ok) {
      setReview(null);
      haptics.success();
      setStatus({
        kind: 'success',
        message: `${chosen.length} item${chosen.length === 1 ? '' : 's'} added from ${review.doc.file_name}.`,
      });
      await load();
    } else {
      setStatus({ kind: 'error', message: result.message });
    }
  };

  const renderRow = (row: MaterialRow, index: number) => {
    const editing = editingId === row.id;
    const confirming = confirmDeleteId === row.id;
    const busyDelete = deletingId === row.id;
    return (
      <FadeInUp key={row.id} index={index}>
        <View style={index > 0 ? styles.rowBorderTop : undefined}>
          <View style={styles.row}>
            <Pill
              label={`× ${formatQty(row.qty)}`}
              bg={colors.sunLight}
              fg={colors.ink}
              style={styles.qtyPill}
            />
            <AppText variant="body" numberOfLines={2} style={styles.rowName}>
              {row.name}
            </AppText>
            {isAdmin ? (
              <>
                <AnimatedPressable
                  onPress={() => (editing ? setEditingId(null) : startEdit(row))}
                  haptic="tapLight"
                  hitSlop={6}
                  accessibilityRole="button"
                  accessibilityLabel={`Edit ${row.name}`}
                  style={styles.iconButton}>
                  <Ionicons name="pencil" size={15} color={colors.accentPrimary} />
                </AnimatedPressable>
                <AnimatedPressable
                  onPress={() => void pressDelete(row)}
                  disabled={busyDelete}
                  haptic="tapLight"
                  hitSlop={6}
                  accessibilityRole="button"
                  accessibilityLabel={confirming ? 'Confirm delete' : `Delete ${row.name}`}
                  style={[styles.iconButton, confirming && styles.iconButtonDanger]}>
                  {busyDelete ? (
                    <ActivityIndicator size="small" color={colors.danger} />
                  ) : (
                    <Ionicons
                      name="trash"
                      size={15}
                      color={confirming ? colors.white : colors.textMuted}
                    />
                  )}
                </AnimatedPressable>
              </>
            ) : null}
          </View>
          {confirming ? (
            <AppText
              variant="caption"
              align="right"
              color={colors.danger}
              style={styles.confirmHint}>
              Tap the trash again to delete this item.
            </AppText>
          ) : null}
          {editing ? (
            <Card tone="sunk" style={styles.editCard}>
              <AppText variant="section" color={colors.textMuted}>
                Item
              </AppText>
              <TextInput
                style={styles.input}
                value={editName}
                onChangeText={setEditName}
                placeholder="Item name"
                placeholderTextColor={colors.textMuted}
              />
              <AppText variant="section" color={colors.textMuted}>
                Quantity
              </AppText>
              <TextInput
                style={styles.input}
                value={editQty}
                onChangeText={setEditQty}
                placeholder="1"
                placeholderTextColor={colors.textMuted}
                keyboardType="decimal-pad"
              />
              <View style={styles.editButtons}>
                <Button
                  label="Cancel"
                  onPress={() => setEditingId(null)}
                  variant="ghost"
                  size="sm"
                  disabled={savingEdit}
                />
                <Button
                  label="Save"
                  onPress={() => void saveEdit(row)}
                  loading={savingEdit}
                  size="sm"
                />
              </View>
            </Card>
          ) : null}
        </View>
      </FadeInUp>
    );
  };

  return (
    <>
      <SectionHeader title="Materials" icon="hammer" style={styles.section} />

      {state === 'loading' ? (
        <SkeletonList count={3} height={44} />
      ) : state === 'unavailable' ? (
        <EmptyState
          icon="hammer"
          title="Materials aren't available"
          body="This list needs the latest database migration before it can load."
        />
      ) : (
        <>
          {materials.length === 0 ? (
            <EmptyState
              icon="hammer"
              title="No materials yet"
              body={
                isAdmin
                  ? 'Add items by hand, or upload a materials PDF below and pull its line items out.'
                  : 'The office adds the parts list here once it is ordered.'
              }
            />
          ) : (
            <Card padded={false}>{materials.map(renderRow)}</Card>
          )}

          {isAdmin ? (
            addOpen ? (
              <Card style={styles.formCard}>
                <AppText variant="section" color={colors.textMuted}>
                  Item
                </AppText>
                <TextInput
                  style={styles.input}
                  value={newName}
                  onChangeText={setNewName}
                  placeholder="e.g. IronRidge XR-100 rail 168in"
                  placeholderTextColor={colors.textMuted}
                />
                <AppText variant="section" color={colors.textMuted}>
                  Quantity
                </AppText>
                <TextInput
                  style={styles.input}
                  value={newQty}
                  onChangeText={setNewQty}
                  placeholder="1"
                  placeholderTextColor={colors.textMuted}
                  keyboardType="decimal-pad"
                />
                <View style={styles.editButtons}>
                  <Button
                    label="Cancel"
                    onPress={() => setAddOpen(false)}
                    variant="ghost"
                    size="sm"
                    disabled={savingAdd}
                  />
                  <Button
                    label="Add"
                    onPress={() => void saveAdd()}
                    loading={savingAdd}
                    size="sm"
                  />
                </View>
              </Card>
            ) : (
              <Button
                label="Add item"
                onPress={() => {
                  setStatus(null);
                  setAddOpen(true);
                }}
                variant="ghost"
                size="sm"
                icon="add-circle"
                style={styles.inlineButton}
              />
            )
          ) : null}

          {docs.length > 0 ? (
            <>
              <SectionHeader title="Materials PDFs" style={styles.subSection} />
              <Card padded={false}>
                {docs.map((doc, index) => (
                  <View key={doc.id} style={[styles.row, index > 0 && styles.rowBorderTop]}>
                    <View style={styles.iconWrap}>
                      <Ionicons name="document-text" size={18} color={colors.accentPrimary} />
                    </View>
                    <AnimatedPressable
                      onPress={() => void openDoc(doc)}
                      haptic="tapLight"
                      scaleTo={0.99}
                      accessibilityRole="button"
                      accessibilityLabel={doc.file_name}
                      style={styles.docBody}>
                      <AppText variant="body" numberOfLines={1}>
                        {doc.file_name}
                      </AppText>
                    </AnimatedPressable>
                    {isAdmin ? (
                      <Button
                        label="Extract"
                        onPress={() => void runExtract(doc)}
                        size="sm"
                        icon="scan"
                        loading={extractingId === doc.id}
                        disabled={extractingId !== null}
                      />
                    ) : null}
                  </View>
                ))}
              </Card>
            </>
          ) : null}

          {review ? (
            <Card style={styles.formCard}>
              <AppText variant="heading">
                Found {review.items.length} item{review.items.length === 1 ? '' : 's'} in{' '}
                {review.doc.file_name}
              </AppText>
              <AppText variant="caption" color={colors.textMuted}>
                Uncheck anything that isn&apos;t a real line item, then add. Quantities can be
                edited after adding.
              </AppText>
              {review.items.map((item, index) => (
                <AnimatedPressable
                  key={`${item.name}-${index}`}
                  onPress={() =>
                    setReview((prev) =>
                      prev
                        ? {
                            ...prev,
                            items: prev.items.map((it, i) =>
                              i === index ? { ...it, checked: !it.checked } : it,
                            ),
                          }
                        : prev,
                    )
                  }
                  haptic="tapLight"
                  scaleTo={0.99}
                  accessibilityRole="checkbox"
                  accessibilityState={{ checked: item.checked }}
                  accessibilityLabel={item.name}
                  style={styles.reviewRow}>
                  <Ionicons
                    name={item.checked ? 'checkbox' : 'square-outline'}
                    size={18}
                    color={colors.accentPrimary}
                  />
                  <AppText variant="bodyStrong" style={styles.reviewQty}>
                    × {formatQty(item.qty)}
                  </AppText>
                  <AppText variant="body" numberOfLines={2} style={styles.reviewName}>
                    {item.name}
                  </AppText>
                </AnimatedPressable>
              ))}
              <View style={styles.editButtons}>
                <Button
                  label="Cancel"
                  onPress={() => setReview(null)}
                  variant="ghost"
                  size="sm"
                  disabled={savingReview}
                />
                <Button
                  label={`Add ${review.items.filter((i) => i.checked).length} items`}
                  onPress={() => void saveReview()}
                  loading={savingReview}
                  size="sm"
                />
              </View>
            </Card>
          ) : null}

          {isAdmin ? (
            <Button
              label="Upload materials PDF"
              onPress={() => void pickAndUpload()}
              variant="secondary"
              icon="cloud-upload"
              loading={uploading}
              fullWidth
            />
          ) : null}
        </>
      )}

      {status ? (
        <AppText
          variant="caption"
          align="center"
          color={status.kind === 'error' ? colors.danger : colors.success}>
          {status.message}
        </AppText>
      ) : null}
    </>
  );
}

const styles = StyleSheet.create({
  section: {
    marginTop: spacing.sm,
  },
  subSection: {
    marginTop: spacing.xs,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    padding: spacing.md,
    backgroundColor: colors.surface,
  },
  rowBorderTop: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
  },
  qtyPill: {
    minWidth: 44,
    alignItems: 'center',
  },
  rowName: {
    flex: 1,
  },
  iconWrap: {
    width: 32,
    height: 32,
    borderRadius: radii.sm,
    backgroundColor: colors.oliveSoft,
    alignItems: 'center',
    justifyContent: 'center',
  },
  docBody: {
    flex: 1,
  },
  iconButton: {
    width: 28,
    height: 28,
    borderRadius: radii.sm,
    backgroundColor: colors.oliveSoft,
    alignItems: 'center',
    justifyContent: 'center',
  },
  iconButtonDanger: {
    backgroundColor: colors.danger,
  },
  confirmHint: {
    paddingHorizontal: spacing.md,
    paddingBottom: spacing.sm,
    backgroundColor: colors.surface,
  },
  editCard: {
    marginHorizontal: spacing.md,
    marginBottom: spacing.md,
    gap: spacing.xs,
  },
  formCard: {
    gap: spacing.xs,
  },
  input: {
    backgroundColor: colors.surface,
    borderRadius: radii.sm,
    borderWidth: 1,
    borderColor: colors.borderStrong,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.sm - 2,
    color: colors.textPrimary,
    ...typography.body,
  },
  editButtons: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'flex-end',
    gap: spacing.sm,
    marginTop: spacing.xs,
  },
  inlineButton: {
    paddingHorizontal: 0,
  },
  reviewRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingVertical: spacing.xs + 2,
  },
  reviewQty: {
    minWidth: 40,
  },
  reviewName: {
    flex: 1,
  },
});
