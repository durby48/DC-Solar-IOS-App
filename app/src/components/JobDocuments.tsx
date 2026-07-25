import Ionicons from '@expo/vector-icons/Ionicons';
import * as DocumentPicker from 'expo-document-picker';
import { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Linking,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';

import { colors, radii, shadows, spacing } from '@/constants/theme';
import {
  DOC_TYPE_LABELS,
  fetchJobDocuments,
  getDocumentUrl,
  uploadJobDocument,
  type DocType,
  type JobDocument,
} from '@/lib/data';
import { formatShortDate } from '@/lib/dates';
import { supabase } from '@/lib/supabase';

const DOC_TYPES = Object.keys(DOC_TYPE_LABELS) as DocType[];

function formatBytes(bytes: number | null): string {
  if (bytes == null || bytes <= 0) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Show success/error feedback: Alert on native, inline status text on web. */
function notify(
  setStatus: (s: { kind: 'success' | 'error'; message: string } | null) => void,
  kind: 'success' | 'error',
  title: string,
  message: string,
) {
  if (Platform.OS === 'web') {
    setStatus({ kind, message: `${title}: ${message}` });
  } else {
    setStatus(null);
    Alert.alert(title, message);
  }
}

export function JobDocuments({ jobId }: { jobId: string }) {
  const [documents, setDocuments] = useState<JobDocument[]>([]);
  const [docsState, setDocsState] = useState<'loading' | 'ok' | 'unavailable'>('loading');
  const [signedIn, setSignedIn] = useState(false);
  const [docType, setDocType] = useState<DocType>('contract');
  const [uploading, setUploading] = useState(false);
  const [status, setStatus] = useState<{ kind: 'success' | 'error'; message: string } | null>(
    null,
  );

  useEffect(() => {
    let cancelled = false;
    supabase.auth.getSession().then(({ data }) => {
      if (!cancelled) setSignedIn(data.session != null);
    });
    const { data: sub } = supabase.auth.onAuthStateChange((_event, session) => {
      if (!cancelled) setSignedIn(session != null);
    });
    return () => {
      cancelled = true;
      sub.subscription.unsubscribe();
    };
  }, []);

  const loadDocuments = useCallback(async () => {
    const result = await fetchJobDocuments(jobId);
    if (result.status === 'ok') {
      setDocuments(result.documents);
      setDocsState('ok');
    } else {
      setDocuments([]);
      setDocsState('unavailable');
    }
  }, [jobId]);

  useEffect(() => {
    setDocsState('loading');
    loadDocuments();
  }, [loadDocuments, signedIn]);

  const openDocument = async (doc: JobDocument) => {
    const url = await getDocumentUrl(doc.storage_path);
    if (!url) {
      notify(setStatus, 'error', 'Could not open document', 'Please try again.');
      return;
    }
    Linking.openURL(url).catch(() => {});
  };

  const pickAndUpload = async () => {
    setStatus(null);
    try {
      const result = await DocumentPicker.getDocumentAsync({
        type: ['application/pdf', 'image/*'],
        copyToCacheDirectory: true,
        multiple: false,
      });
      if (result.canceled || !result.assets?.length) return;
      const asset = result.assets[0];

      setUploading(true);
      const upload = await uploadJobDocument({
        jobId,
        docType,
        fileName: asset.name ?? 'document.pdf',
        uri: asset.uri,
        contentType: asset.mimeType ?? 'application/pdf',
      });
      if (upload.ok) {
        setDocuments((prev) => [upload.document, ...prev]);
        setDocsState('ok');
        notify(setStatus, 'success', 'Uploaded', `${upload.document.file_name} was added.`);
      } else {
        notify(setStatus, 'error', 'Upload failed', upload.message);
      }
    } catch {
      notify(setStatus, 'error', 'Upload failed', 'Something went wrong. Please try again.');
    } finally {
      setUploading(false);
    }
  };

  return (
    <>
      <Text style={styles.sectionTitle}>Documents</Text>
      {docsState === 'loading' ? (
        <View style={styles.placeholderCard}>
          <ActivityIndicator color={colors.ocean} />
        </View>
      ) : docsState === 'unavailable' ? (
        <View style={styles.placeholderCard}>
          <Ionicons name="document-text" size={22} color={colors.inkSoft} />
          <Text style={styles.placeholderText}>
            {signedIn ? 'Documents not set up yet' : 'Sign in as an admin to view documents'}
          </Text>
        </View>
      ) : documents.length === 0 ? (
        <View style={styles.placeholderCard}>
          <Ionicons name="document-text" size={22} color={colors.inkSoft} />
          <Text style={styles.placeholderText}>
            {signedIn ? 'No documents yet' : 'Sign in to view and upload documents.'}
          </Text>
        </View>
      ) : (
        <View style={styles.card}>
          {documents.map((doc, index) => (
            <Pressable
              key={doc.id}
              onPress={() => openDocument(doc)}
              style={({ pressed }) => [
                styles.row,
                index > 0 && styles.rowBorderTop,
                pressed && styles.rowPressed,
              ]}>
              <View style={styles.iconWrap}>
                <Ionicons name="document-text" size={18} color={colors.ocean} />
              </View>
              <View style={styles.rowBody}>
                <Text style={styles.rowValue} numberOfLines={1}>
                  {doc.file_name}
                </Text>
                <View style={styles.metaRow}>
                  <View style={styles.typeChip}>
                    <Text style={styles.typeChipText}>
                      {DOC_TYPE_LABELS[doc.doc_type] ?? doc.doc_type}
                    </Text>
                  </View>
                  <Text style={styles.metaText}>
                    {formatShortDate(doc.created_at?.slice(0, 10) ?? null)}
                    {formatBytes(doc.size_bytes) ? ` · ${formatBytes(doc.size_bytes)}` : ''}
                  </Text>
                </View>
              </View>
              <Ionicons name="chevron-forward" size={18} color={colors.inkSoft} />
            </Pressable>
          ))}
        </View>
      )}

      {signedIn ? (
        <>
          <View style={styles.typeSelector}>
            {DOC_TYPES.map((type) => (
              <Pressable
                key={type}
                onPress={() => setDocType(type)}
                style={[styles.typeOption, docType === type && styles.typeOptionSelected]}>
                <Text
                  style={[
                    styles.typeOptionText,
                    docType === type && styles.typeOptionTextSelected,
                  ]}>
                  {DOC_TYPE_LABELS[type]}
                </Text>
              </Pressable>
            ))}
          </View>
          <Pressable
            onPress={pickAndUpload}
            disabled={uploading}
            style={({ pressed }) => [
              styles.uploadButton,
              (pressed || uploading) && styles.uploadButtonPressed,
            ]}>
            {uploading ? (
              <ActivityIndicator color={colors.ink} />
            ) : (
              <Ionicons name="cloud-upload" size={18} color={colors.ink} />
            )}
            <Text style={styles.uploadButtonText}>
              {uploading ? 'Uploading…' : `Upload ${DOC_TYPE_LABELS[docType].toLowerCase()}`}
            </Text>
          </Pressable>
        </>
      ) : null}

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
    gap: spacing.md,
    padding: spacing.md,
  },
  rowBorderTop: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.tan,
  },
  rowPressed: {
    backgroundColor: colors.skySoft,
  },
  iconWrap: {
    width: 32,
    height: 32,
    borderRadius: radii.sm,
    backgroundColor: colors.skySoft,
    alignItems: 'center',
    justifyContent: 'center',
  },
  rowBody: {
    flex: 1,
    gap: 2,
  },
  rowValue: {
    color: colors.ink,
    fontSize: 15,
    fontWeight: '600',
  },
  metaRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
  },
  typeChip: {
    backgroundColor: colors.skySoft,
    borderRadius: radii.pill,
    paddingHorizontal: spacing.sm,
    paddingVertical: 2,
  },
  typeChipText: {
    color: colors.ocean,
    fontSize: 11,
    fontWeight: '700',
  },
  metaText: {
    color: colors.inkSoft,
    fontSize: 12,
    fontWeight: '600',
  },
  typeSelector: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.sm,
  },
  typeOption: {
    backgroundColor: colors.white,
    borderRadius: radii.pill,
    borderWidth: 1,
    borderColor: colors.tan,
    paddingHorizontal: spacing.sm + 2,
    paddingVertical: spacing.xs,
  },
  typeOptionSelected: {
    backgroundColor: colors.sunLight,
    borderColor: colors.sun,
  },
  typeOptionText: {
    color: colors.inkSoft,
    fontSize: 12,
    fontWeight: '700',
  },
  typeOptionTextSelected: {
    color: colors.ink,
  },
  uploadButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.sm,
    backgroundColor: colors.sun,
    borderRadius: radii.pill,
    paddingVertical: spacing.md - 2,
    paddingHorizontal: spacing.lg,
    ...shadows.card,
  },
  uploadButtonPressed: {
    opacity: 0.7,
  },
  uploadButtonText: {
    color: colors.ink,
    fontSize: 15,
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
