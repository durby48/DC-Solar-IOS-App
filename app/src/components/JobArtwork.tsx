import { Image } from 'expo-image';
import { useCallback, useEffect, useState } from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';

import { PropertyArt } from '@/components/PropertyArt';
import { AnimatedPressable, AppText, Button, Card, SectionHeader } from '@/components/ui';
import { colors, radii, spacing } from '@/constants/theme';
import {
  fetchArtworkUrl,
  fetchJobArtwork,
  generateArtwork,
  type JobArtwork as ArtworkRow,
} from '@/lib/artwork';
import { fetchJobPhotos, getPhotoUrl, type JobPhoto } from '@/lib/data';
import { type Job } from '@/lib/types';

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
 *
 * 2026-08-22 restyle: `Card`, `Button` and `AppText` replace the local
 * card/sun-button/outline-button/hint styles. The live preview is untouched —
 * it has to keep looking exactly like the pipeline card it stands for.
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
      <SectionHeader title="Property artwork" icon="color-wand" style={styles.section} />
      <Card style={styles.card}>
        {/* Live preview of exactly what the pipeline card will show. */}
        <View style={styles.preview}>
          <PropertyArt seed={job.id} imageUrl={url} radius={radii.sm} />
          <View style={styles.previewLabelWrap}>
            <AppText variant="bodyStrong">
              {url ? 'Cartoon of this property' : 'Placeholder illustration'}
            </AppText>
            <AppText variant="caption" color={colors.textMuted}>
              {row?.status === 'failed'
                ? (row.error ?? 'Last attempt failed.')
                : url
                  ? `From ${row?.source === 'photo' ? 'your photo' : 'Street View'}`
                  : 'No artwork generated yet'}
            </AppText>
          </View>
        </View>

        <View style={styles.buttonRow}>
          <Button
            label={url ? 'Regenerate from address' : 'Generate from address'}
            onPress={() => void run({ force: true })}
            icon="color-wand"
            loading={busy}
            disabled={!hasAddress}
            style={styles.grow}
          />
          <Button
            label="Use a photo"
            onPress={() => void openPicker()}
            variant="secondary"
            icon="images"
            disabled={busy}
          />
        </View>

        {!hasAddress ? (
          <AppText variant="caption" color={colors.textMuted}>
            This job has no address, so Street View can&apos;t find it. Upload a photo of the
            property and pick it with “Use a photo”.
          </AppText>
        ) : null}

        {pickerOpen ? (
          photos.length === 0 ? (
            <AppText variant="caption" color={colors.textMuted}>
              No photos on this job yet — add one in the Photos section above, then come back.
            </AppText>
          ) : (
            <ScrollView horizontal showsHorizontalScrollIndicator={false}>
              <View style={styles.photoRow}>
                {photos.map((photo) => {
                  const signed = photoUrls.get(photo.id);
                  return (
                    <AnimatedPressable
                      key={photo.id}
                      onPress={() => void run({ photoPath: photo.storage_path, force: true })}
                      disabled={busy}
                      haptic="tapMedium"
                      accessibilityRole="button"
                      accessibilityLabel="Use this photo for the artwork"
                      style={styles.photoTile}>
                      {signed ? (
                        <Image
                          source={{ uri: signed }}
                          style={styles.photoImage}
                          contentFit="cover"
                        />
                      ) : (
                        <View style={styles.photoImage} />
                      )}
                    </AnimatedPressable>
                  );
                })}
              </View>
            </ScrollView>
          )
        ) : null}

        {status ? (
          <AppText
            variant="caption"
            align="center"
            color={status.kind === 'error' ? colors.danger : colors.success}>
            {status.message}
          </AppText>
        ) : null}
      </Card>
    </>
  );
}

const styles = StyleSheet.create({
  section: {
    marginTop: spacing.sm,
  },
  card: {
    gap: spacing.sm,
  },
  preview: {
    height: 120,
    borderRadius: radii.sm,
    overflow: 'hidden',
    justifyContent: 'flex-end',
    backgroundColor: colors.surfaceSunk,
  },
  previewLabelWrap: {
    padding: spacing.sm,
  },
  buttonRow: {
    flexDirection: 'row',
    gap: spacing.sm,
  },
  grow: {
    flexGrow: 1,
    flexShrink: 1,
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
    backgroundColor: colors.surfaceSunk,
  },
  photoImage: {
    width: '100%',
    height: '100%',
  },
});
