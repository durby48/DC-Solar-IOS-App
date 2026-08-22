import Ionicons from '@expo/vector-icons/Ionicons';
import { Image } from 'expo-image';
import * as ImagePicker from 'expo-image-picker';
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';

import { MediaLightbox, type LightboxItem } from '@/components/MediaLightbox';
import { colors, radii, shadows, spacing } from '@/constants/theme';
import {
  deleteJobPhoto,
  fetchJobPhotos,
  getPhotoUrl,
  uploadJobPhoto,
  type JobPhoto,
} from '@/lib/data';
import { useRole } from '@/lib/role';
import { supabase } from '@/lib/supabase';

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
 * A job's photos.
 *
 * Tapping a thumbnail opens `MediaLightbox` — pinch-zoom, paging, share.
 * Until 2026-08-22 it called `Linking.openURL` on the signed Supabase URL,
 * which THREW THE CREW OUT OF THE APP: Safari opened, the photo loaded again
 * over cell data, and coming back re-mounted the job screen. Photos live where
 * you tapped them now. Upload and the two-tap delete are unchanged.
 *
 * These are `job_photos` rows, not `media_assets`, so the viewer gets no
 * `assetId` and draws no caption/tag editor — there is no row for it to write.
 */
export function JobPhotos({ jobId }: { jobId: string }) {
  const role = useRole();
  const [photos, setPhotos] = useState<JobPhoto[]>([]);
  const [photosState, setPhotosState] = useState<'loading' | 'ok' | 'unavailable'>('loading');
  const [urls, setUrls] = useState<Record<string, string>>({});
  const [viewerIndex, setViewerIndex] = useState<number | null>(null);
  const [signedIn, setSignedIn] = useState(false);
  const [uploading, setUploading] = useState(false);
  // Two-tap delete confirm (admins): first tap arms the red badge, second deletes.
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
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

  /** Sign URLs for any photos we don't have a cached URL for yet. */
  const signUrls = useCallback(async (list: JobPhoto[]) => {
    const pairs = await Promise.all(
      list.map(async (p) => [p.id, await getPhotoUrl(p.storage_path)] as const),
    );
    setUrls((prev) => {
      const next = { ...prev };
      for (const [id, url] of pairs) {
        if (url) next[id] = url;
      }
      return next;
    });
  }, []);

  const loadPhotos = useCallback(async () => {
    const result = await fetchJobPhotos(jobId);
    if (result.status === 'ok') {
      setPhotos(result.photos);
      setPhotosState('ok');
      signUrls(result.photos);
    } else {
      setPhotos([]);
      setPhotosState('unavailable');
    }
  }, [jobId, signUrls]);

  useEffect(() => {
    setPhotosState('loading');
    loadPhotos();
  }, [loadPhotos, signedIn]);

  /**
   * The photos the viewer can actually show, in grid order. A photo whose URL
   * has not been signed yet is skipped rather than paged onto a black screen,
   * so the tapped index is resolved against THIS list, not `photos`.
   */
  const viewerItems = useMemo<LightboxItem[]>(
    () =>
      photos
        .filter((photo) => Boolean(urls[photo.id]))
        .map((photo) => ({
          id: photo.id,
          url: urls[photo.id],
          caption: photo.caption ?? null,
          fileName: photo.storage_path.split('/').pop() ?? 'photo.jpg',
        })),
    [photos, urls],
  );

  const openPhoto = async (photo: JobPhoto) => {
    const url = urls[photo.id] ?? (await getPhotoUrl(photo.storage_path));
    if (!url) {
      notify(setStatus, 'error', 'Could not open photo', 'Please try again.');
      return;
    }
    // A photo signed only now is not in `viewerItems` yet, so the index is
    // computed against the list the NEXT render will build — opening on the
    // wrong photo is worse than a frame of delay.
    const nextUrls = urls[photo.id] ? urls : { ...urls, [photo.id]: url };
    if (!urls[photo.id]) setUrls(nextUrls);
    const visible = photos.filter((p) => Boolean(nextUrls[p.id]));
    setViewerIndex(Math.max(0, visible.findIndex((p) => p.id === photo.id)));
  };

  const pressDelete = async (photo: JobPhoto) => {
    if (confirmDeleteId !== photo.id) {
      setStatus(null);
      setConfirmDeleteId(photo.id);
      return;
    }
    setConfirmDeleteId(null);
    setDeletingId(photo.id);
    const result = await deleteJobPhoto(photo);
    setDeletingId(null);
    if (result.ok) {
      setStatus({ kind: 'success', message: 'Photo deleted.' });
      await loadPhotos();
    } else {
      notify(setStatus, 'error', 'Could not delete photo', result.message);
    }
  };

  const uploadAssets = async (assets: ImagePicker.ImagePickerAsset[]) => {
    if (assets.length === 0) return;
    setUploading(true);
    let uploadedCount = 0;
    let firstError: string | null = null;
    for (const asset of assets) {
      const result = await uploadJobPhoto({
        jobId,
        uri: asset.uri,
        fileName: asset.fileName ?? null,
        contentType: asset.mimeType ?? 'image/jpeg',
      });
      if (result.ok) {
        uploadedCount += 1;
        setPhotos((prev) => [result.photo, ...prev]);
        setPhotosState('ok');
        signUrls([result.photo]);
      } else if (!firstError) {
        firstError = result.message;
      }
    }
    setUploading(false);
    if (firstError) {
      notify(setStatus, 'error', 'Upload failed', firstError);
    } else if (uploadedCount > 0) {
      notify(
        setStatus,
        'success',
        'Uploaded',
        uploadedCount === 1 ? 'Photo added.' : `${uploadedCount} photos added.`,
      );
    }
  };

  const takePhoto = async () => {
    setStatus(null);
    try {
      const perm = await ImagePicker.requestCameraPermissionsAsync();
      if (!perm.granted) {
        notify(setStatus, 'error', 'Camera unavailable', 'Camera permission was not granted.');
        return;
      }
      const result = await ImagePicker.launchCameraAsync({ quality: 0.7 });
      if (result.canceled || !result.assets?.length) return;
      await uploadAssets(result.assets);
    } catch {
      notify(setStatus, 'error', 'Upload failed', 'Something went wrong. Please try again.');
    }
  };

  const pickFromLibrary = async () => {
    setStatus(null);
    try {
      const result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ['images'],
        allowsMultipleSelection: true,
        quality: 0.7,
      });
      if (result.canceled || !result.assets?.length) return;
      await uploadAssets(result.assets);
    } catch {
      notify(setStatus, 'error', 'Upload failed', 'Something went wrong. Please try again.');
    }
  };

  const chooseSource = () => {
    Alert.alert('Add photo', undefined, [
      { text: 'Take photo', onPress: () => void takePhoto() },
      { text: 'Choose from library', onPress: () => void pickFromLibrary() },
      { text: 'Cancel', style: 'cancel' },
    ]);
  };

  return (
    <>
      <Text style={styles.sectionTitle}>Photos</Text>
      {photosState === 'loading' ? (
        <View style={styles.placeholderCard}>
          <ActivityIndicator color={colors.ocean} />
        </View>
      ) : photosState === 'unavailable' || photos.length === 0 ? (
        <View style={styles.placeholderCard}>
          <Ionicons name="camera" size={22} color={colors.inkSoft} />
          <Text style={styles.placeholderText}>
            {photosState === 'unavailable'
              ? signedIn
                ? 'Photos not set up yet'
                : 'Sign in to view photos'
              : 'No photos yet'}
          </Text>
        </View>
      ) : (
        <View style={styles.grid}>
          {photos.map((photo) => {
            const confirming = confirmDeleteId === photo.id;
            const busy = deletingId === photo.id;
            return (
              <Pressable
                key={photo.id}
                onPress={() => openPhoto(photo)}
                style={({ pressed }) => [styles.thumbWrap, pressed && styles.thumbPressed]}>
                {urls[photo.id] ? (
                  <Image
                    source={{ uri: urls[photo.id] }}
                    style={styles.thumb}
                    contentFit="cover"
                    transition={150}
                  />
                ) : (
                  <View style={[styles.thumb, styles.thumbLoading]}>
                    <ActivityIndicator color={colors.ocean} size="small" />
                  </View>
                )}
                {role?.isAdmin ? (
                  <Pressable
                    onPress={() => void pressDelete(photo)}
                    disabled={busy}
                    hitSlop={6}
                    style={[styles.deleteBadge, confirming && styles.deleteBadgeArmed]}>
                    {busy ? (
                      <ActivityIndicator size="small" color={colors.white} />
                    ) : (
                      <Ionicons name="trash" size={13} color={colors.white} />
                    )}
                  </Pressable>
                ) : null}
                {confirming ? (
                  <View style={styles.confirmStrip}>
                    <Text style={styles.confirmStripText}>Tap again to delete</Text>
                  </View>
                ) : null}
              </Pressable>
            );
          })}
        </View>
      )}

      {signedIn ? (
        uploading ? (
          <View style={[styles.addButton, styles.addButtonPressed]}>
            <ActivityIndicator color={colors.ink} />
            <Text style={styles.addButtonText}>Uploading…</Text>
          </View>
        ) : Platform.OS === 'web' ? (
          <View style={styles.webButtonRow}>
            <Pressable
              onPress={takePhoto}
              style={({ pressed }) => [
                styles.addButton,
                styles.webButton,
                pressed && styles.addButtonPressed,
              ]}>
              <Ionicons name="camera" size={18} color={colors.ink} />
              <Text style={styles.addButtonText}>Camera</Text>
            </Pressable>
            <Pressable
              onPress={pickFromLibrary}
              style={({ pressed }) => [
                styles.addButton,
                styles.webButton,
                pressed && styles.addButtonPressed,
              ]}>
              <Ionicons name="images" size={18} color={colors.ink} />
              <Text style={styles.addButtonText}>Library</Text>
            </Pressable>
          </View>
        ) : (
          <Pressable
            onPress={chooseSource}
            style={({ pressed }) => [styles.addButton, pressed && styles.addButtonPressed]}>
            <Ionicons name="camera" size={18} color={colors.ink} />
            <Text style={styles.addButtonText}>Add photo</Text>
          </Pressable>
        )
      ) : (
        <Text style={styles.signInNote}>Sign in to add photos</Text>
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

      {viewerIndex !== null && viewerItems.length > 0 ? (
        <MediaLightbox
          items={viewerItems}
          index={Math.min(viewerIndex, viewerItems.length - 1)}
          visible
          onClose={() => setViewerIndex(null)}
        />
      ) : null}
    </>
  );
}

const GRID_GAP = spacing.sm;

const styles = StyleSheet.create({
  sectionTitle: {
    color: colors.ink,
    fontSize: 18,
    fontWeight: '700',
    marginTop: spacing.sm,
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
  grid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: GRID_GAP,
  },
  thumbWrap: {
    width: `${(100 - 2 * 2.5) / 3}%`, // 3 columns with gap slack
    aspectRatio: 1,
    borderRadius: radii.sm,
    overflow: 'hidden',
    backgroundColor: colors.skySoft,
    ...shadows.card,
  },
  thumbPressed: {
    opacity: 0.7,
  },
  deleteBadge: {
    position: 'absolute',
    top: 4,
    right: 4,
    width: 24,
    height: 24,
    borderRadius: 12,
    backgroundColor: 'rgba(61, 53, 46, 0.65)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  deleteBadgeArmed: {
    backgroundColor: colors.danger,
  },
  confirmStrip: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: colors.danger,
    paddingVertical: 2,
  },
  confirmStripText: {
    color: colors.white,
    fontSize: 10,
    fontWeight: '800',
    textAlign: 'center',
  },
  thumb: {
    width: '100%',
    height: '100%',
  },
  thumbLoading: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  webButtonRow: {
    flexDirection: 'row',
    gap: spacing.sm,
  },
  webButton: {
    flex: 1,
  },
  addButton: {
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
  addButtonPressed: {
    opacity: 0.7,
  },
  addButtonText: {
    color: colors.ink,
    fontSize: 15,
    fontWeight: '800',
  },
  signInNote: {
    color: colors.inkSoft,
    fontSize: 13,
    fontWeight: '600',
    textAlign: 'center',
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
