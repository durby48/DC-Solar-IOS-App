import Ionicons from '@expo/vector-icons/Ionicons';
import { StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';

import { colors, radii, spacing } from '@/constants/theme';
import { AppText } from './AppText';
import { Button } from './Button';

type IconName = keyof typeof Ionicons.glyphMap;

/**
 * What a screen shows when there is genuinely nothing to show.
 *
 * The `body` line is the important one, and it is not decoration: this app
 * is replacing mock data with real empty states, and "No leads yet" on its
 * own leaves a crew member wondering whether the app is broken or the list
 * is simply empty. Say which, and say what to do about it.
 *
 * Quiet by design — no card, no shadow. An empty state should not look more
 * important than the content it stands in for.
 */
export function EmptyState({
  icon,
  title,
  body,
  action,
  style,
}: {
  icon?: IconName;
  title: string;
  /** One or two sentences: why it's empty, and what fills it. */
  body?: string;
  action?: { label: string; onPress: () => void };
  style?: StyleProp<ViewStyle>;
}) {
  return (
    <View style={[styles.wrap, style]}>
      {icon ? (
        <View style={styles.iconWrap}>
          <Ionicons name={icon} size={26} color={colors.oliveMid} />
        </View>
      ) : null}

      <AppText variant="heading" align="center">
        {title}
      </AppText>

      {body ? (
        <AppText variant="body" color={colors.textMuted} align="center" style={styles.body}>
          {body}
        </AppText>
      ) : null}

      {action ? (
        <Button label={action.label} onPress={action.onPress} variant="secondary" size="sm" />
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    alignItems: 'center',
    gap: spacing.sm,
    paddingVertical: spacing.xl,
    paddingHorizontal: spacing.lg,
  },
  iconWrap: {
    width: 56,
    height: 56,
    borderRadius: radii.pill,
    backgroundColor: colors.oliveTint,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: spacing.xs,
  },
  body: {
    maxWidth: 320,
  },
});
