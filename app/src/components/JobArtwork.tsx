import Ionicons from '@expo/vector-icons/Ionicons';
import { Image } from 'expo-image';
import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { PropertyArt } from '@/components/PropertyArt';
import { colors, radii, shadows, spacing } from '@/constants/theme';
import {
  fetchArtworkUrl,
  fetchJobArtwork,
  generateArtwork,
  type JobArtwork as ArtworkRow,
} from '@/lib/artwork';
import { fetchJobPhotos, getPhotoUrl, type JobPhoto } from '@/lib/data';
import { type Job } from '@/lib/mockData';

/**
 * Admin-only "Property artwork" card on the job screen.
 *
 * The artwork is the cartoon picture used as this job's pipeline-card
 * background. Two ways to set it:
 *   • Generate from the address — Street View photo → Gemini cartoon.
 *   • Use one of the job's own photos — for addresses Street View can't see,
 *     or when the Street View shot is of the wrong house.
 *
 * The parent gates on isAdmin. Everything degrades quietly: if the edge
 * function has no GOOGLE_API_KEY yet, the error surfaces here as plain text
 * and the pipeline keeps showing the drawn fallback illustration.
 */
export function JobArtwork({ job }: { job: Job }) {
  const [row, setRow] = useState<ArtworkRow | null>(null);
  const [url, setUrl] = useState<string | null>(null);
  const [photos, setPhotos] = useState<JobPhoto[]>([]);
  const [photoUrls, setPhotoUrls] = useState<Map<string, string>>(new Map());
  const [pickerOpen, setPickerOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<{ kind: 'success' | 'error'; message: string } | null>(
    null,
  );

  const load = useCallback(async () => {
    const rows = await fetchJobArtwork();
    const mine = rows.get(job.id) ?? null;
    setRow(mine);
    setUrl(mine?.status === 'ready' ? await fetchArtworkUrl(job.id) : null);
  }, [job.id]);

  useEffect(() => {
    load();
  }, [load]);

  const openPicker = useCallback(async () => {
    setStatus(null);
    setPickerOpen((open) => !open);
    if (photos.length > 0) return;
    const result = await fetchJobPhotos(job.id);
    if (result.status !== 'ok') return;
    setPhotos(result.photos);
    const urls = new Map<string, string>();
    await Promise.all(
      result.photos.map(async (photo) => {
        const signed = await getPhotoUrl(photo.storage_path);
        if (signed) urls.set(photo.id, signed);
      }),
    );
    setPhotoUrls(urls);
  }, [job.id, photos.length]);

  const run = useCallback(
    async (options: { photoPath?: string; force?: boolean }) => {
      setBusy(true);
      setStatus(null);
      const result = await generateArtwork(job.id, options);
      setBusy(false);
      if (result.ok) {
        setPickerOpen(false);
        setStatus({
          kind: 'success',
          message: result.cached ? 'Artwork already up to date.' : 'Artwork created.',
        });
        await load();
      } else {
        setStatus({ kind: 'error', message: result.message });
      }
    },
    [job.id, load],
  );

  const hasAddress = Boolean(job.address && job.address.trim().length > 0);

  return (
    <>
      <Text style={styles.sectionTitle}>Property artwork</Text>
      <View style={styles.card}>
        {/* Live preview of exactly what the pipeline card will show. */}
        <View style={styles.preview}>
          <PropertyArt seed={job.id} imageUrl={url} radius={radii.sm} />
          <View style={styles.previewLabelWrap}>
            <Text style={styles.previewLabel}>
              {url ? 'Cartoon of this property' : 'Placeholder illustration'}
            </Text>
            <Text style={styles.previewSub}>
              {row?.status === 'failed'
                ? (row.error ?? 'Last attempt failed.')
                : url
                  ? `From ${row?.source === 'photo' ? 'your photo' : 'Street View'}`
                  : 'No artwork generated yet'}
            </Text>
          </View>
        </View>

        <View style={styles.buttonRow}>
          <Pressable
            onPress={() => void run({ force: true })}
            disabled={busy || !hasAddress}
            style={({ pressed }) => [
              styles.primaryButton,
              (!hasAddress || busy) && styles.buttonDisabled,
              pressed && styles.buttonPressed,
            ]}>
            {busy ? (
              <ActivityIndicator color={colors.ink} />
            ) : (
              <Ionicons name="color-wand" size={16} color={colors.ink} />
            )}
            <Text style={styles.primaryButtonText}>
              {url ? 'Regenerate from address' : 'Generate from address'}
            </Text>
          </Pressable>
          <Pressable
            onPress={() => void openPicker()}
            disabled={busy}
            style={({ pressed }) => [styles.outlineButton, pressed && styles.buttonPressed]}>
            <Ionicons name="images" size={16} color={colors.ink} />
            <Text style={styles.outlineButtonText}>Use a photo</Text>
          </Pressable>
        </View>

        {!hasAddress ? (
          <Text style={styles.hint}>
            This job has no address, so Street View can&apos;t find it. Upload a photo of the
            property and pick it with “Use a photo”.
          </Text>
        ) : null}

        {pickerOpen ? (
          photos.length === 0 ? (
            <Text style={styles.hint}>
              No photos on this job yet — add one in the Photos section above, then come back.
            </Text>
          ) : (
            <ScrollView horizontal showsHorizontalScrollIndicator={false}>
              <View style={styles.photoRow}>
                {photos.map((photo) => {
                  const signed = photoUrls.get(photo.id);
                  return (
                    <Pressable
                      key={photo.id}
                      onPress={() => void run({ photoPath: photo.storage_path, force: true })}
                      disabled={busy}
                      style={({ pressed }) => [styles.photoTile, pressed && styles.buttonPressed]}>
                      {signed ? (
                        <Image
                          source={{ uri: signed }}
                          style={styles.photoImage}
                          contentFit="cover"
                        />
                      ) : (
                        <View style={styles.photoImage} />
                      )}
                    </Pressable>
                  );
                })}
              </View>
            </ScrollView>
          )
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
      </View>
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
    padding: spacing.md,
    gap: spacing.sm,
    ...shadows.card,
  },
  preview: {
    height: 120,
    borderRadius: radii.sm,
    overflow: 'hidden',
    justifyContent: 'flex-end',
    backgroundColor: colors.skySoft,
  },
  previewLabelWrap: {
    padding: spacing.sm,
  },
  previewLabel: {
    color: colors.ink,
    fontSize: 14,
    fontWeight: '800',
  },
  previewSub: {
    color: colors.inkSoft,
    fontSize: 12,
    fontWeight: '600',
  },
  buttonRow: {
    flexDirection: 'row',
    gap: spacing.sm,
  },
  primaryButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.xs,
    flexGrow: 1,
    backgroundColor: colors.sun,
    borderRadius: radii.pill,
    paddingVertical: spacing.md - 4,
    paddingHorizontal: spacing.md,
    ...shadows.card,
  },
  primaryButtonText: {
    color: colors.ink,
    fontSize: 14,
    fontWeight: '800',
  },
  outlineButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.xs,
    backgroundColor: colors.white,
    borderWidth: 1,
    borderColor: colors.line,
    borderRadius: radii.pill,
    paddingVertical: spacing.md - 4,
    paddingHorizontal: spacing.md,
  },
  outlineButtonText: {
    color: colors.ink,
    fontSize: 14,
    fontWeight: '800',
  },
  buttonDisabled: {
    opacity: 0.5,
  },
  buttonPressed: {
    opacity: 0.7,
  },
  hint: {
    color: colors.inkSoft,
    fontSize: 12,
    fontWeight: '600',
  },
  photoRow: {
    flexDirection: 'row',
    gap: spacing.sm,
    paddingVertical: spacing.xs,
  },
  photoTile: {
    width: 78,
    height: 58,
    borderRadius: radii.sm,
    overflow: 'hidden',
    backgroundColor: colors.skySoft,
  },
  photoImage: {
    width: '100%',
    height: '100%',
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
