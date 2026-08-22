import Ionicons from '@expo/vector-icons/Ionicons';
import { StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { AppText, GradientSurface } from '@/components/ui';
import { accentCycle, colors, spacing } from '@/constants/theme';
import { formatFullDate } from '@/lib/dates';
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
 */
export function HomeHeader() {
  const insets = useSafeAreaInsets();
  const role = useRole();

  const displayName = role?.displayName ?? null;
  const firstName = displayName ? displayName.trim().split(/\s+/)[0] : null;

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

        <Avatar name={displayName} email={role?.email ?? null} />
      </View>
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
 * Initials on a stable tint. Same hash-into-`accentCycle` trick as
 * `EmployeeOfMonth` and `CustomerAvatar`, so one person is the same colour
 * everywhere in the app.
 *
 * Signed out (or before the role lands) there are no initials to draw, so it
 * falls back to a glyph rather than inventing a letter.
 */
function Avatar({ name, email }: { name: string | null; email: string | null }) {
  const initials = (name ?? '')
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? '')
    .join('');

  if (!initials) {
    return (
      <View style={[styles.avatar, styles.avatarBlank]}>
        <Ionicons name="person" size={22} color={colors.textOnDark} />
      </View>
    );
  }

  const seed = email ?? name ?? '';
  const hash = [...seed].reduce((acc, ch) => (acc * 31 + ch.charCodeAt(0)) >>> 0, 7);
  const accent = accentCycle[hash % accentCycle.length];

  return (
    <View style={[styles.avatar, { backgroundColor: accent.bg }]}>
      <AppText variant="heading" color={accent.fg}>
        {initials}
      </AppText>
    </View>
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
  avatar: {
    width: AVATAR,
    height: AVATAR,
    borderRadius: AVATAR / 2,
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatarBlank: {
    // A tinted well rather than a solid circle: nothing is being identified.
    backgroundColor: colors.oliveLine,
  },
});
