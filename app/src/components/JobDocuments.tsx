import Ionicons from '@expo/vector-icons/Ionicons';
import * as DocumentPicker from 'expo-document-picker';
import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Alert, Platform, StyleSheet, View } from 'react-native';

import {
  AnimatedPressable,
  AppText,
  Button,
  Card,
  Chip,
  EmptyState,
  FadeInUp,
  SectionHeader,
  SkeletonList,
} from '@/components/ui';
import { colors, radii, spacing } from '@/constants/theme';
import {
  DOC_TYPE_LABELS,
  fetchJobDocuments,
  getDocumentUrl,
  uploadJobDocument,
  type DocType,
  type JobDocument,
} from '@/lib/data';
import { formatShortDate } from '@/lib/dates';
import { haptics } from '@/lib/haptics';
import { shareDocument, viewDocument } from '@/lib/pdf';
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

/**
 * The job's uploaded paperwork: contracts, permits, materials PDFs.
 *
 * 2026-08-22 restyle: `Card` / `Chip` / `Button` / `EmptyState` from the kit,
 * a `SkeletonList` in place of the bare first-load spinner, and rows that
 * stagger in with `FadeInUp`. The Alert-on-native / inline-on-web split in
 * `notify` is untouched, and so is every upload and share path.
 */
export function JobDocuments({ jobId }: { jobId: string }) {
  const [documents, setDocuments] = useState<JobDocument[]>([]);
  const [docsState, setDocsState] = useState<'loading' | 'ok' | 'unavailable'>('loading');
  const [signedIn, setSignedIn] = useState(false);
  const [docType, setDocType] = useState<DocType>('contract');
  const [uploading, setUploading] = useState(false);
  const [status, setStatus] = useState<{ kind: 'success' | 'error'; message: string } | null>(
    null,
  );
  const [sharingId, setSharingId] = useState<string | null>(null);

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
    if (!url || !(await viewDocument(url))) {
      notify(setStatus, 'error', 'Could not open document', 'Please try again.');
    }
  };

  const shareDoc = async (doc: JobDocument) => {
    setSharingId(doc.id);
    try {
      const url = await getDocumentUrl(doc.storage_path);
      if (!url || !(await shareDocument(url, doc.file_name))) {
        notify(setStatus, 'error', 'Could not share document', 'Please try again.');
      }
    } finally {
      setSharingId(null);
    }
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
        haptics.success();
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
      <SectionHeader title="Documents" icon="document-text" style={styles.section} />
      {docsState === 'loading' ? (
        <SkeletonList count={2} height={64} />
      ) : docsState === 'unavailable' ? (
        <EmptyState
          icon="document-text"
          title={signedIn ? 'Documents not set up yet' : 'Sign in to see documents'}
          body={
            signedIn
              ? 'This company has no document storage yet. Ask the office to finish setup.'
              : 'Sign in as an admin to view the paperwork filed against this job.'
          }
        />
      ) : documents.length === 0 ? (
        <EmptyState
          icon="document-text"
          title={signedIn ? 'No documents yet' : 'Sign in to view documents'}
          body={
            signedIn
              ? 'Contracts, permits and anything else you upload for this job land here.'
              : 'Sign in to view and upload documents.'
          }
        />
      ) : (
        <Card padded={false}>
          {documents.map((doc, index) => (
            <FadeInUp key={doc.id} index={index}>
              <AnimatedPressable
                onPress={() => openDocument(doc)}
                haptic="tapLight"
                scaleTo={0.99}
                accessibilityRole="button"
                accessibilityLabel={doc.file_name}
                style={[styles.row, index > 0 && styles.rowBorderTop]}>
                <View style={styles.iconWrap}>
                  <Ionicons name="document-text" size={18} color={colors.accentPrimary} />
                </View>
                <View style={styles.rowBody}>
                  <AppText variant="bodyStrong" numberOfLines={1}>
                    {doc.file_name}
                  </AppText>
                  <View style={styles.metaRow}>
                    <Chip label={DOC_TYPE_LABELS[doc.doc_type] ?? doc.doc_type} tone="olive" />
                    <AppText variant="caption" color={colors.textMuted}>
                      {formatShortDate(doc.created_at?.slice(0, 10) ?? null)}
                      {formatBytes(doc.size_bytes) ? ` · ${formatBytes(doc.size_bytes)}` : ''}
                    </AppText>
                  </View>
                </View>
                <AnimatedPressable
                  onPress={() => shareDoc(doc)}
                  disabled={sharingId !== null}
                  haptic="tapLight"
                  hitSlop={8}
                  accessibilityRole="button"
                  accessibilityLabel={`Share ${doc.file_name}`}
                  style={styles.shareButton}>
                  {sharingId === doc.id ? (
                    <ActivityIndicator size="small" color={colors.accentPrimary} />
                  ) : (
                    <Ionicons name="share-outline" size={18} color={colors.accentPrimary} />
                  )}
                </AnimatedPressable>
                <Ionicons name="chevron-forward" size={18} color={colors.textMuted} />
              </AnimatedPressable>
            </FadeInUp>
          ))}
        </Card>
      )}

      {signedIn ? (
        <>
          <View style={styles.typeSelector}>
            {DOC_TYPES.map((type) => (
              <Chip
                key={type}
                label={DOC_TYPE_LABELS[type]}
                tone="olive"
                selected={docType === type}
                onPress={() => setDocType(type)}
              />
            ))}
          </View>
          <Button
            label={uploading ? 'Uploading…' : `Upload ${DOC_TYPE_LABELS[docType].toLowerCase()}`}
            onPress={pickAndUpload}
            icon="cloud-upload"
            loading={uploading}
            fullWidth
          />
        </>
      ) : null}

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
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    padding: spacing.md,
    backgroundColor: colors.surface,
  },
  rowBorderTop: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
  },
  iconWrap: {
    width: 32,
    height: 32,
    borderRadius: radii.sm,
    backgroundColor: colors.oliveSoft,
    alignItems: 'center',
    justifyContent: 'center',
  },
  shareButton: {
    width: 32,
    height: 32,
    borderRadius: radii.sm,
    alignItems: 'center',
    justifyContent: 'center',
  },
  rowBody: {
    flex: 1,
    gap: 2,
  },
  metaRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
  },
  typeSelector: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.sm,
  },
});
