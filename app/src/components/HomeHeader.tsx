import Ionicons from '@expo/vector-icons/Ionicons';
import { Image } from 'expo-image';
import * as ImagePicker from 'expo-image-picker';
import { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { AppText, GradientSurface } from '@/components/ui';
import { accentCycle, colors, radii, spacing } from '@/constants/theme';
import { formatFullDate } from '@/lib/dates';
import * as haptics from '@/lib/haptics';
import { clearMyAvatar, fetchMyProfile, uploadMyAvatar } from '@/lib/profile';
import { useRole } from '@/lib/role';

/**
 * The olive band at the top of Home: who you are, what day it is, and a
 * greeting that changes with the clock.
 *
 * It paints THROUGH the status bar (it adds the top inset itself rather than
 * sitting inside a `SafeAreaView`), because the point of the band is that the
 * brand colour runs to the very top of the phone and the clock card then
 * floats over its lower edge. That is also why it is a scroll child rather
 * than `Screen`'s `header` slot — a negatively-offset card overlapping a
 * fixed header gets clipped by the scroll container on web.
 *
 * Cream text only. See the olive contrast rules in `constants/theme`.
 *
 * THE AVATAR IS THE PROFILE PICTURE CONTROL. Tapping it opens a small panel
 * under the greeting rather than a modal: this band is already the top of the
 * scroll view, so a sheet would cover the thing being changed, and an inline
 * panel keeps the circle visible while you replace it. Every employee gets the
 * same panel — it is self-service, and RLS restricts each write to that
 * person's own row (see `lib/profile.ts`).
 */
export function HomeHeader() {
  const insets = useSafeAreaInsets();
  const role = useRole();

  const displayName = role?.displayName ?? null;
  const firstName = displayName ? displayName.trim().split(/\s+/)[0] : null;
  const email = role?.email ?? null;

  const [avatarUrl, setAvatarUrl] = useState<string | null>(null);
  const [hasPhoto, setHasPhoto] = useState(false);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Signing a private-bucket URL is a round trip, so it happens once per
  // signed-in session rather than on every render of the band.
  useEffect(() => {
    let cancelled = false;
    if (!email) {
      setAvatarUrl(null);
      setHasPhoto(false);
      setOpen(false);
      return;
    }
    fetchMyProfile().then((profile) => {
      if (cancelled) return;
      setAvatarUrl(profile?.avatarUrl ?? null);
      setHasPhoto(Boolean(profile?.avatarPath));
    });
    return () => {
      cancelled = true;
    };
  }, [email]);

  const save = useCallback(async (uri: string) => {
    setBusy(true);
    setError(null);
    const result = await uploadMyAvatar(uri);
    setBusy(false);
    if (!result.ok) {
      setError(result.message);
      return;
    }
    setAvatarUrl(result.profile.avatarUrl);
    setHasPhoto(Boolean(result.profile.avatarPath));
    setOpen(false);
    haptics.success();
  }, []);

  const choosePhoto = useCallback(async () => {
    setError(null);
    try {
      const result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ['images'],
        allowsEditing: true,
        aspect: [1, 1],
        quality: 0.8,
      });
      if (result.canceled || !result.assets?.length) return;
      await save(result.assets[0].uri);
    } catch {
      setError('Could not open your photo library.');
    }
  }, [save]);

  const takePhoto = useCallback(async () => {
    setError(null);
    try {
      const permission = await ImagePicker.requestCameraPermissionsAsync();
      if (!permission.granted) {
        setError('Camera permission was not granted.');
        return;
      }
      const result = await ImagePicker.launchCameraAsync({
        allowsEditing: true,
        aspect: [1, 1],
        quality: 0.8,
      });
      if (result.canceled || !result.assets?.length) return;
      await save(result.assets[0].uri);
    } catch {
      setError('Could not open the camera.');
    }
  }, [save]);

  const removePhoto = useCallback(async () => {
    setBusy(true);
    setError(null);
    const result = await clearMyAvatar();
    setBusy(false);
    if (!result.ok) {
      setError(result.message);
      return;
    }
    setAvatarUrl(null);
    setHasPhoto(false);
    setOpen(false);
    haptics.success();
  }, []);

  return (
    <GradientSurface gradient="olive" style={[styles.band, { paddingTop: insets.top + spacing.lg }]}>
      <View style={styles.row}>
        <View style={styles.text}>
          <AppText variant="display" color={colors.textOnDark} numberOfLines={2}>
            {greeting()}
            {firstName ? `, ${firstName}` : ''}
          </AppText>
          <AppText variant="body" color={colors.oliveSoft}>
            {formatFullDate(new Date())}
          </AppText>
        </View>

        <Avatar
          name={displayName}
          email={email}
          url={avatarUrl}
          busy={busy}
          onPress={email ? () => setOpen((was) => !was) : undefined}
        />
      </View>

      {open ? (
        <PhotoPanel
          hasPhoto={hasPhoto}
          busy={busy}
          error={error}
          onChoose={() => void choosePhoto()}
          onTake={() => void takePhoto()}
          onRemove={() => void removePhoto()}
          onClose={() => setOpen(false)}
        />
      ) : null}
    </GradientSurface>
  );
}

/**
 * Time-of-day greeting. Moved here from `(tabs)/index.tsx` when that file
 * became the hub — the greeting belongs to the header, not to the screen.
 */
export function greeting(): string {
  const hour = new Date().getHours();
  if (hour < 12) return 'Good morning';
  if (hour < 17) return 'Good afternoon';
  return 'Good evening';
}

/**
 * The photo when there is one, initials otherwise.
 *
 * Initials sit on a stable tint — the same hash-into-`accentCycle` trick as
 * `EmployeeOfMonth` and `CustomerAvatar`, so one person is the same colour
 * everywhere in the app. Signed out (or before the role lands) there are no
 * initials to draw, so it falls back to a glyph rather than inventing a letter,
 * and it is not tappable: there is nobody to save a photo for.
 */
function Avatar({
  name,
  email,
  url,
  busy,
  onPress,
}: {
  name: string | null;
  email: string | null;
  url: string | null;
  busy: boolean;
  onPress?: () => void;
}) {
  const initials = (name ?? '')
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? '')
    .join('');

  const seed = email ?? name ?? '';
  const hash = [...seed].reduce((acc, ch) => (acc * 31 + ch.charCodeAt(0)) >>> 0, 7);
  const accent = accentCycle[hash % accentCycle.length];

  const inner = url ? (
    <Image
      source={{ uri: url }}
      style={styles.avatarImage}
      contentFit="cover"
      cachePolicy="memory-disk"
      transition={180}
    />
  ) : initials ? (
    <View style={[styles.avatar, { backgroundColor: accent.bg }]}>
      <AppText variant="heading" color={accent.fg}>
        {initials}
      </AppText>
    </View>
  ) : (
    <View style={[styles.avatar, styles.avatarBlank]}>
      <Ionicons name="person" size={22} color={colors.textOnDark} />
    </View>
  );

  const body = (
    <View style={styles.avatarWrap}>
      {inner}
      {busy ? (
        <View style={[styles.avatar, styles.avatarBusy]}>
          <ActivityIndicator color={colors.textOnDark} size="small" />
        </View>
      ) : onPress ? (
        <View style={styles.avatarBadge}>
          <Ionicons name="camera" size={11} color={colors.olive} />
        </View>
      ) : null}
    </View>
  );

  if (!onPress) return body;

  return (
    <Pressable
      onPress={() => {
        haptics.tapLight();
        onPress();
      }}
      disabled={busy}
      hitSlop={6}
      accessibilityRole="button"
      accessibilityLabel="Change your profile photo"
      style={({ pressed }) => pressed && styles.pressed}>
      {body}
    </Pressable>
  );
}

/**
 * The action panel. Deliberately the same shape as `PhoneActionSheet` — a
 * cream card of icon-plus-label rows — so the app has one vocabulary for
 * "here are the things you can do with this".
 *
 * "Take photo" is native only. `expo-image-picker`'s camera launcher opens a
 * `getUserMedia` prompt on the web that most desktop browsers answer with a
 * webcam nobody wants a headshot from, so app.dcsolarkc.com offers the library
 * alone rather than a row that mostly disappoints.
 */
function PhotoPanel({
  hasPhoto,
  busy,
  error,
  onChoose,
  onTake,
  onRemove,
  onClose,
}: {
  hasPhoto: boolean;
  busy: boolean;
  error: string | null;
  onChoose: () => void;
  onTake: () => void;
  onRemove: () => void;
  onClose: () => void;
}) {
  return (
    <View style={styles.panel}>
      <View style={styles.panelHeader}>
        <Text style={styles.panelTitle}>Profile photo</Text>
        <Pressable
          onPress={onClose}
          hitSlop={8}
          accessibilityRole="button"
          accessibilityLabel="Close"
          style={({ pressed }) => pressed && styles.pressed}>
          <Ionicons name="close" size={18} color={colors.inkSoft} />
        </Pressable>
      </View>

      <PanelRow icon="images" label="Choose photo" disabled={busy} onPress={onChoose} />
      {Platform.OS !== 'web' ? (
        <PanelRow icon="camera" label="Take photo" disabled={busy} onPress={onTake} />
      ) : null}
      {hasPhoto ? (
        <PanelRow icon="trash" label="Remove photo" disabled={busy} danger onPress={onRemove} />
      ) : null}

      {error ? <Text style={styles.panelError}>{error}</Text> : null}
      <Text style={styles.panelNote}>Only you can change your own photo.</Text>
    </View>
  );
}

function PanelRow({
  icon,
  label,
  disabled,
  danger,
  onPress,
}: {
  icon: keyof typeof Ionicons.glyphMap;
  label: string;
  disabled: boolean;
  danger?: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      style={({ pressed }) => [
        styles.panelRow,
        disabled && styles.panelRowDisabled,
        pressed && !disabled && styles.panelRowPressed,
      ]}>
      <View style={[styles.panelIcon, danger && styles.panelIconDanger]}>
        <Ionicons name={icon} size={15} color={danger ? colors.danger : colors.olive} />
      </View>
      <Text style={[styles.panelLabel, danger && styles.panelLabelDanger]}>{label}</Text>
    </Pressable>
  );
}

const AVATAR = 48;

const styles = StyleSheet.create({
  band: {
    paddingHorizontal: spacing.lg,
    // Deep enough that the clock card can overlap it and still leave olive
    // showing above and beside the card's shoulders.
    paddingBottom: spacing.xxl,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
  },
  text: {
    flex: 1,
    gap: spacing.xs,
  },
  avatarWrap: {
    width: AVATAR,
    height: AVATAR,
  },
  avatar: {
    width: AVATAR,
    height: AVATAR,
    borderRadius: AVATAR / 2,
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatarImage: {
    width: AVATAR,
    height: AVATAR,
    borderRadius: AVATAR / 2,
    backgroundColor: colors.oliveLine,
  },
  avatarBlank: {
    // A tinted well rather than a solid circle: nothing is being identified.
    backgroundColor: colors.oliveLine,
  },
  avatarBusy: {
    position: 'absolute',
    top: 0,
    left: 0,
    width: AVATAR,
    height: AVATAR,
    backgroundColor: 'rgba(58,70,31,0.55)',
  },
  avatarBadge: {
    position: 'absolute',
    right: -2,
    bottom: -2,
    width: 20,
    height: 20,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.cream,
  },
  pressed: { opacity: 0.7 },

  panel: {
    marginTop: spacing.md,
    backgroundColor: colors.canvas,
    borderRadius: radii.md,
    padding: spacing.sm,
    gap: spacing.xs,
  },
  panelHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.xs,
    paddingBottom: spacing.xs,
  },
  panelTitle: { color: colors.ink, fontSize: 15, fontWeight: '800' },
  panelRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    backgroundColor: colors.white,
    borderRadius: radii.sm,
    padding: spacing.sm,
  },
  panelRowPressed: { backgroundColor: colors.oliveSoft },
  panelRowDisabled: { opacity: 0.55 },
  panelIcon: {
    width: 28,
    height: 28,
    borderRadius: radii.sm,
    backgroundColor: colors.oliveSoft,
    alignItems: 'center',
    justifyContent: 'center',
  },
  panelIconDanger: { backgroundColor: colors.dangerSoft },
  panelLabel: { color: colors.ink, fontSize: 14, fontWeight: '700' },
  panelLabelDanger: { color: colors.danger },
  panelError: {
    color: colors.danger,
    fontSize: 12,
    fontWeight: '700',
    paddingHorizontal: spacing.xs,
    paddingTop: spacing.xs,
  },
  panelNote: {
    color: colors.inkSoft,
    fontSize: 12,
    fontWeight: '600',
    paddingHorizontal: spacing.xs,
    paddingTop: 2,
  },
});
