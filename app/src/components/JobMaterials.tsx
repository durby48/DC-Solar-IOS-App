import Ionicons from '@expo/vector-icons/Ionicons';
import * as DocumentPicker from 'expo-document-picker';
import { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';

import { colors, radii, shadows, spacing } from '@/constants/theme';
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
 */
export function JobMaterials({
  jobId,
  isAdmin,
  isMock,
}: {
  jobId: string;
  isAdmin: boolean;
  isMock: boolean;
}) {
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
    if (isMock) {
      setState('unavailable');
      return;
    }
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
  }, [jobId, isMock]);

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
      <View key={row.id} style={index > 0 ? styles.rowBorderTop : undefined}>
        <View style={styles.row}>
          <View style={styles.qtyChip}>
            <Text style={styles.qtyChipText}>× {formatQty(row.qty)}</Text>
          </View>
          <Text style={styles.rowName} numberOfLines={2}>
            {row.name}
          </Text>
          {isAdmin ? (
            <>
              <Pressable
                onPress={() => (editing ? setEditingId(null) : startEdit(row))}
                hitSlop={6}
                style={({ pressed }) => [styles.iconButton, pressed && styles.pressed]}>
                <Ionicons name="pencil" size={15} color={colors.ocean} />
              </Pressable>
              <Pressable
                onPress={() => void pressDelete(row)}
                disabled={busyDelete}
                hitSlop={6}
                style={({ pressed }) => [
                  styles.iconButton,
                  confirming && styles.iconButtonDanger,
                  pressed && styles.pressed,
                ]}>
                {busyDelete ? (
                  <ActivityIndicator size="small" color={colors.danger} />
                ) : (
                  <Ionicons
                    name="trash"
                    size={15}
                    color={confirming ? colors.white : colors.inkSoft}
                  />
                )}
              </Pressable>
            </>
          ) : null}
        </View>
        {confirming ? (
          <Text style={styles.confirmHint}>Tap the trash again to delete this item.</Text>
        ) : null}
        {editing ? (
          <View style={styles.editCard}>
            <Text style={styles.fieldLabel}>Item</Text>
            <TextInput
              style={styles.input}
              value={editName}
              onChangeText={setEditName}
              placeholder="Item name"
              placeholderTextColor={colors.inkSoft}
            />
            <Text style={styles.fieldLabel}>Quantity</Text>
            <TextInput
              style={styles.input}
              value={editQty}
              onChangeText={setEditQty}
              placeholder="1"
              placeholderTextColor={colors.inkSoft}
              keyboardType="decimal-pad"
            />
            <View style={styles.editButtons}>
              <Pressable onPress={() => setEditingId(null)} disabled={savingEdit} hitSlop={8}>
                <Text style={styles.cancelText}>Cancel</Text>
              </Pressable>
              <Pressable
                onPress={() => void saveEdit(row)}
                disabled={savingEdit}
                style={({ pressed }) => [
                  styles.sunButton,
                  styles.saveEditButton,
                  (pressed || savingEdit) && styles.pressed,
                ]}>
                {savingEdit ? (
                  <ActivityIndicator color={colors.ink} />
                ) : (
                  <Text style={styles.sunButtonText}>Save</Text>
                )}
              </Pressable>
            </View>
          </View>
        ) : null}
      </View>
    );
  };

  return (
    <>
      <Text style={styles.sectionTitle}>Materials</Text>

      {state === 'loading' ? (
        <View style={styles.placeholderCard}>
          <ActivityIndicator color={colors.ocean} />
        </View>
      ) : state === 'unavailable' ? (
        <View style={styles.placeholderCard}>
          <Ionicons name="hammer" size={22} color={colors.inkSoft} />
          <Text style={styles.placeholderText}>
            {isMock ? 'Materials are available on real jobs.' : 'Materials need the latest database migration.'}
          </Text>
        </View>
      ) : (
        <>
          {materials.length === 0 ? (
            <View style={styles.placeholderCard}>
              <Ionicons name="hammer" size={22} color={colors.inkSoft} />
              <Text style={styles.placeholderText}>
                {isAdmin
                  ? 'No materials yet — add items or upload a materials PDF below.'
                  : 'No materials listed yet.'}
              </Text>
            </View>
          ) : (
            <View style={styles.card}>{materials.map(renderRow)}</View>
          )}

          {isAdmin ? (
            addOpen ? (
              <View style={styles.formCard}>
                <Text style={styles.fieldLabel}>Item</Text>
                <TextInput
                  style={styles.input}
                  value={newName}
                  onChangeText={setNewName}
                  placeholder="e.g. IronRidge XR-100 rail 168in"
                  placeholderTextColor={colors.inkSoft}
                />
                <Text style={styles.fieldLabel}>Quantity</Text>
                <TextInput
                  style={styles.input}
                  value={newQty}
                  onChangeText={setNewQty}
                  placeholder="1"
                  placeholderTextColor={colors.inkSoft}
                  keyboardType="decimal-pad"
                />
                <View style={styles.editButtons}>
                  <Pressable onPress={() => setAddOpen(false)} disabled={savingAdd} hitSlop={8}>
                    <Text style={styles.cancelText}>Cancel</Text>
                  </Pressable>
                  <Pressable
                    onPress={() => void saveAdd()}
                    disabled={savingAdd}
                    style={({ pressed }) => [
                      styles.sunButton,
                      styles.saveEditButton,
                      (pressed || savingAdd) && styles.pressed,
                    ]}>
                    {savingAdd ? (
                      <ActivityIndicator color={colors.ink} />
                    ) : (
                      <Text style={styles.sunButtonText}>Add</Text>
                    )}
                  </Pressable>
                </View>
              </View>
            ) : (
              <Pressable
                onPress={() => {
                  setStatus(null);
                  setAddOpen(true);
                }}
                style={({ pressed }) => [styles.addToggle, pressed && styles.pressed]}>
                <Ionicons name="add-circle" size={18} color={colors.ocean} />
                <Text style={styles.addToggleText}>Add item</Text>
              </Pressable>
            )
          ) : null}

          {docs.length > 0 ? (
            <>
              <Text style={styles.subTitle}>Materials PDFs</Text>
              <View style={styles.card}>
                {docs.map((doc, index) => (
                  <View
                    key={doc.id}
                    style={[styles.row, index > 0 && styles.rowBorderTop]}>
                    <View style={styles.iconWrap}>
                      <Ionicons name="document-text" size={18} color={colors.ocean} />
                    </View>
                    <Pressable
                      onPress={() => void openDoc(doc)}
                      style={({ pressed }) => [styles.docBody, pressed && styles.pressed]}>
                      <Text style={styles.rowName} numberOfLines={1}>
                        {doc.file_name}
                      </Text>
                    </Pressable>
                    {isAdmin ? (
                      <Pressable
                        onPress={() => void runExtract(doc)}
                        disabled={extractingId !== null}
                        style={({ pressed }) => [
                          styles.extractButton,
                          pressed && styles.pressed,
                        ]}>
                        {extractingId === doc.id ? (
                          <ActivityIndicator size="small" color={colors.ink} />
                        ) : (
                          <>
                            <Ionicons name="scan" size={14} color={colors.ink} />
                            <Text style={styles.extractButtonText}>Extract</Text>
                          </>
                        )}
                      </Pressable>
                    ) : null}
                  </View>
                ))}
              </View>
            </>
          ) : null}

          {review ? (
            <View style={styles.formCard}>
              <Text style={styles.reviewTitle}>
                Found {review.items.length} item{review.items.length === 1 ? '' : 's'} in{' '}
                {review.doc.file_name}
              </Text>
              <Text style={styles.reviewHint}>
                Uncheck anything that isn't a real line item, then add. Quantities can be
                edited after adding.
              </Text>
              {review.items.map((item, index) => (
                <Pressable
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
                  style={({ pressed }) => [styles.reviewRow, pressed && styles.pressed]}>
                  <Ionicons
                    name={item.checked ? 'checkbox' : 'square-outline'}
                    size={18}
                    color={colors.ocean}
                  />
                  <Text style={styles.reviewQty}>× {formatQty(item.qty)}</Text>
                  <Text style={styles.reviewName} numberOfLines={2}>
                    {item.name}
                  </Text>
                </Pressable>
              ))}
              <View style={styles.editButtons}>
                <Pressable onPress={() => setReview(null)} disabled={savingReview} hitSlop={8}>
                  <Text style={styles.cancelText}>Cancel</Text>
                </Pressable>
                <Pressable
                  onPress={() => void saveReview()}
                  disabled={savingReview}
                  style={({ pressed }) => [
                    styles.sunButton,
                    styles.saveEditButton,
                    (pressed || savingReview) && styles.pressed,
                  ]}>
                  {savingReview ? (
                    <ActivityIndicator color={colors.ink} />
                  ) : (
                    <Text style={styles.sunButtonText}>
                      Add {review.items.filter((i) => i.checked).length} items
                    </Text>
                  )}
                </Pressable>
              </View>
            </View>
          ) : null}

          {isAdmin ? (
            <Pressable
              onPress={() => void pickAndUpload()}
              disabled={uploading}
              style={({ pressed }) => [
                styles.outlineButton,
                (pressed || uploading) && styles.pressed,
              ]}>
              {uploading ? (
                <ActivityIndicator color={colors.ink} />
              ) : (
                <Ionicons name="cloud-upload" size={16} color={colors.ink} />
              )}
              <Text style={styles.outlineButtonText}>Upload materials PDF</Text>
            </Pressable>
          ) : null}
        </>
      )}

      {status ? (
        <Text
          style={[
            styles.statusText,
            status.kind === 'error' ? styles.statusError : styles.statusSuccess,
          ]}>
          {status.message}
        </Text>
      ) : null}
    </>
  );
}

const styles = StyleSheet.create({
  sectionTitle: {
    color: colors.ink,
    fontSize: 18,
    fontWeight: '700',
    marginTop: spacing.sm,
  },
  subTitle: {
    color: colors.inkSoft,
    fontSize: 13,
    fontWeight: '800',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginTop: spacing.xs,
  },
  card: {
    backgroundColor: colors.white,
    borderRadius: radii.md,
    overflow: 'hidden',
    ...shadows.card,
  },
  placeholderCard: {
    backgroundColor: colors.skySoft,
    borderRadius: radii.md,
    padding: spacing.lg,
    alignItems: 'center',
    gap: spacing.xs,
  },
  placeholderText: {
    color: colors.inkSoft,
    fontSize: 14,
    fontWeight: '600',
    textAlign: 'center',
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    padding: spacing.md,
  },
  rowBorderTop: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.tan,
  },
  qtyChip: {
    backgroundColor: colors.sunLight,
    borderRadius: radii.pill,
    paddingHorizontal: spacing.sm,
    paddingVertical: 2,
    minWidth: 44,
    alignItems: 'center',
  },
  qtyChipText: {
    color: colors.ink,
    fontSize: 13,
    fontWeight: '800',
    fontVariant: ['tabular-nums'],
  },
  rowName: {
    flex: 1,
    color: colors.ink,
    fontSize: 14,
    fontWeight: '600',
  },
  iconWrap: {
    width: 32,
    height: 32,
    borderRadius: radii.sm,
    backgroundColor: colors.skySoft,
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
    backgroundColor: colors.skySoft,
    alignItems: 'center',
    justifyContent: 'center',
  },
  iconButtonDanger: {
    backgroundColor: colors.danger,
  },
  pressed: {
    opacity: 0.7,
  },
  confirmHint: {
    color: colors.danger,
    fontSize: 12,
    fontWeight: '700',
    paddingHorizontal: spacing.md,
    paddingBottom: spacing.sm,
    textAlign: 'right',
  },
  editCard: {
    backgroundColor: colors.cream,
    marginHorizontal: spacing.md,
    marginBottom: spacing.md,
    borderRadius: radii.sm,
    padding: spacing.md,
    gap: spacing.xs,
  },
  formCard: {
    backgroundColor: colors.white,
    borderRadius: radii.md,
    padding: spacing.md,
    gap: spacing.xs,
    ...shadows.card,
  },
  fieldLabel: {
    color: colors.inkSoft,
    fontSize: 11,
    fontWeight: '700',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  input: {
    backgroundColor: colors.cream,
    borderRadius: radii.sm,
    borderWidth: 1,
    borderColor: colors.tan,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.sm - 2,
    color: colors.ink,
    fontSize: 15,
    fontWeight: '600',
  },
  editButtons: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'flex-end',
    gap: spacing.md,
    marginTop: spacing.xs,
  },
  cancelText: {
    color: colors.inkSoft,
    fontSize: 14,
    fontWeight: '700',
  },
  sunButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.xs,
    backgroundColor: colors.sun,
    borderRadius: radii.pill,
    paddingVertical: spacing.md - 4,
    paddingHorizontal: spacing.md,
    ...shadows.card,
  },
  sunButtonText: {
    color: colors.ink,
    fontSize: 14,
    fontWeight: '800',
  },
  saveEditButton: {
    flexGrow: 0,
    paddingHorizontal: spacing.lg,
  },
  addToggle: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    paddingVertical: spacing.xs,
  },
  addToggleText: {
    color: colors.ocean,
    fontSize: 14,
    fontWeight: '700',
  },
  extractButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    backgroundColor: colors.sun,
    borderRadius: radii.pill,
    paddingHorizontal: spacing.sm + 2,
    paddingVertical: spacing.xs + 2,
  },
  extractButtonText: {
    color: colors.ink,
    fontSize: 12,
    fontWeight: '800',
  },
  reviewTitle: {
    color: colors.ink,
    fontSize: 15,
    fontWeight: '800',
  },
  reviewHint: {
    color: colors.inkSoft,
    fontSize: 12,
    fontWeight: '600',
  },
  reviewRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingVertical: spacing.xs + 2,
  },
  reviewQty: {
    color: colors.ink,
    fontSize: 13,
    fontWeight: '800',
    fontVariant: ['tabular-nums'],
    minWidth: 40,
  },
  reviewName: {
    flex: 1,
    color: colors.ink,
    fontSize: 13,
    fontWeight: '600',
  },
  outlineButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.xs,
    backgroundColor: colors.white,
    borderWidth: 1,
    borderColor: colors.tan,
    borderRadius: radii.pill,
    paddingVertical: spacing.md - 4,
    paddingHorizontal: spacing.md,
  },
  outlineButtonText: {
    color: colors.ink,
    fontSize: 14,
    fontWeight: '800',
  },
  statusText: {
    fontSize: 13,
    fontWeight: '600',
    textAlign: 'center',
  },
  statusError: {
    color: colors.danger,
  },
  statusSuccess: {
    color: colors.ocean,
  },
});
