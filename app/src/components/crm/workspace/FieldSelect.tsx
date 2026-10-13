import Ionicons from '@expo/vector-icons/Ionicons';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';

import { colors, radii, spacing } from '@/constants/theme';

/**
 * A labelled dropdown for the CRM details panel (2026-10-12, Devon: "turn
 * them into drop down menus"). Label on the left, the current value in a box
 * with a chevron; a tap opens the choices inline underneath (no modal, so it
 * behaves the same on the web and the phone). The parent decides which one is
 * open, so only one menu shows at a time.
 *
 * Choices come as `options`, or as `children` for a custom menu (Panels: quick
 * picks plus an exact number).
 */

export interface FieldOption {
  value: string;
  label: string;
  icon?: keyof typeof Ionicons.glyphMap;
  color?: string;
  /** Shown but not choosable (e.g. statuses the service visit drives). */
  disabled?: boolean;
  hint?: string;
}

export function FieldSelect({
  label,
  value,
  display,
  icon,
  iconColor,
  open,
  onToggle,
  options,
  onSelect,
  busy = false,
  children,
}: {
  label: string;
  /** The current option's value ('' = nothing set). */
  value: string;
  /** What the closed box shows; defaults to the current option's label. */
  display?: string;
  icon?: keyof typeof Ionicons.glyphMap;
  iconColor?: string;
  open: boolean;
  onToggle: () => void;
  options?: FieldOption[];
  onSelect?: (value: string) => void;
  busy?: boolean;
  children?: React.ReactNode;
}) {
  const current = options?.find((o) => o.value === value);
  const shown = display ?? current?.label ?? 'Not set';
  const shownIcon = icon ?? current?.icon;
  const shownColor = iconColor ?? current?.color ?? colors.inkSoft;
  const unset = !value && display === undefined;

  return (
    <View style={styles.wrap}>
      <View style={styles.row}>
        <Text style={styles.label}>{label}</Text>
        <Pressable
          onPress={onToggle}
          disabled={busy}
          accessibilityRole="button"
          accessibilityLabel={`${label}: ${shown}`}
          accessibilityState={{ expanded: open }}
          style={({ pressed }) => [styles.box, open && styles.boxOpen, pressed && styles.pressed]}>
          {shownIcon ? <Ionicons name={shownIcon} size={14} color={shownColor} /> : null}
          <Text style={[styles.value, unset && styles.muted]} numberOfLines={1}>
            {shown}
          </Text>
          {busy ? (
            <ActivityIndicator size="small" color={colors.inkSoft} />
          ) : (
            <Ionicons name={open ? 'chevron-up' : 'chevron-down'} size={14} color={colors.inkSoft} />
          )}
        </Pressable>
      </View>
      {open ? (
        <View style={styles.menu}>
          {children ??
            options?.map((o) => {
              const selected = o.value === value;
              return (
                <Pressable
                  key={o.value || 'none'}
                  onPress={() => onSelect?.(o.value)}
                  disabled={o.disabled}
                  accessibilityRole="menuitem"
                  accessibilityState={{ selected, disabled: o.disabled }}
                  style={({ pressed }) => [styles.option, pressed && styles.pressed]}>
                  {o.icon ? <Ionicons name={o.icon} size={14} color={o.disabled ? colors.line : (o.color ?? colors.inkSoft)} /> : null}
                  <Text style={[styles.optionText, o.disabled && styles.disabled]}>{o.label}</Text>
                  {o.hint ? <Text style={styles.hint}>{o.hint}</Text> : null}
                  {selected ? <Ionicons name="checkmark" size={15} color={colors.olive} /> : null}
                </Pressable>
              );
            })}
        </View>
      ) : null}
    </View>
  );
}

/** A plain row inside a custom menu, styled like an option. */
export function FieldMenuRow({
  label,
  selected,
  onPress,
}: {
  label: string;
  selected?: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable onPress={onPress} accessibilityRole="menuitem" style={({ pressed }) => [styles.option, pressed && styles.pressed]}>
      <Text style={styles.optionText}>{label}</Text>
      {selected ? <Ionicons name="checkmark" size={15} color={colors.olive} /> : null}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  wrap: { gap: spacing.xs },
  row: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  label: { width: 88, color: colors.inkSoft, fontSize: 12, fontWeight: '700' },
  box: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    minHeight: 34,
    paddingHorizontal: spacing.sm + 2,
    borderRadius: radii.sm,
    borderWidth: 1,
    borderColor: colors.line,
    backgroundColor: colors.canvas,
  },
  boxOpen: { borderColor: colors.inkSoft },
  value: { flex: 1, color: colors.ink, fontSize: 13, fontWeight: '700' },
  muted: { color: colors.inkSoft, fontWeight: '600' },
  menu: {
    marginLeft: 88 + spacing.sm,
    backgroundColor: colors.canvas,
    borderRadius: radii.sm,
    borderWidth: 1,
    borderColor: colors.line,
    overflow: 'hidden',
  },
  option: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingHorizontal: spacing.sm + 2,
    paddingVertical: spacing.sm,
  },
  optionText: { flex: 1, color: colors.ink, fontSize: 13, fontWeight: '600' },
  disabled: { color: colors.inkSoft, fontWeight: '500' },
  hint: { color: colors.inkSoft, fontSize: 11, fontWeight: '600' },
  pressed: { opacity: 0.6 },
});
