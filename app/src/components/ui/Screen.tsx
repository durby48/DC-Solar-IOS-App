import type { ReactNode } from 'react';
import {
  RefreshControl,
  ScrollView,
  StyleSheet,
  View,
  type StyleProp,
  type ViewStyle,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { colors, spacing, type GradientKey } from '@/constants/theme';
import { GradientSurface } from './GradientSurface';

/**
 * The page shell: safe area, scrolling, pull-to-refresh, and an optional
 * bleeding header surface.
 *
 * Two layouts, chosen by whether you pass `header`:
 *
 *   no header  — `SafeAreaView edges={['top']}` around the body. This is what
 *                the tab screens do today and what `more/*` screens (which
 *                get a native Stack header instead) should NOT use the top
 *                edge for — pass `edges={[]}` there.
 *   header     — the header sits ABOVE the scroll body and, when `gradient`
 *                is set, paints under the status bar so the olive runs to the
 *                top of the phone. The body scrolls beneath it.
 *
 * The refresh spinner is olive on every platform, because the crew pulls to
 * refresh constantly and it was the last ocean-tinted control left over.
 */
export function Screen({
  children,
  scroll = true,
  refreshing = false,
  onRefresh,
  header,
  gradient,
  headerStyle,
  edges = ['top'],
  padded = true,
  background = colors.surfaceAlt,
  contentContainerStyle,
  style,
}: {
  children: ReactNode;
  /** `false` for a screen that manages its own scrolling (FlatList, board). */
  scroll?: boolean;
  refreshing?: boolean;
  /** Omit and no `RefreshControl` is attached at all. */
  onRefresh?: () => void;
  /** Header content — greeting, title, avatar. Rendered above the body. */
  header?: ReactNode;
  /** Fills the header surface from `gradients`. Requires `header`. */
  gradient?: GradientKey;
  headerStyle?: StyleProp<ViewStyle>;
  /** Safe-area edges. Use `[]` under a native Stack header. */
  edges?: readonly ('top' | 'bottom' | 'left' | 'right')[];
  /** Standard page insets on the scroll content. */
  padded?: boolean;
  background?: string;
  contentContainerStyle?: StyleProp<ViewStyle>;
  style?: StyleProp<ViewStyle>;
}) {
  const body = scroll ? (
    <ScrollView
      style={styles.flex}
      contentContainerStyle={[padded && styles.content, contentContainerStyle]}
      keyboardShouldPersistTaps="handled"
      refreshControl={
        onRefresh ? (
          <RefreshControl
            refreshing={refreshing}
            onRefresh={onRefresh}
            tintColor={colors.accentPrimary}
            colors={[colors.accentPrimary]}
            progressBackgroundColor={colors.surface}
          />
        ) : undefined
      }>
      {children}
    </ScrollView>
  ) : (
    <View style={[styles.flex, padded && styles.content, contentContainerStyle]}>{children}</View>
  );

  if (!header) {
    return (
      <SafeAreaView edges={edges} style={[styles.flex, { backgroundColor: background }, style]}>
        {body}
      </SafeAreaView>
    );
  }

  return (
    <View style={[styles.flex, { backgroundColor: background }, style]}>
      {gradient ? (
        <GradientSurface gradient={gradient} style={headerStyle}>
          <SafeAreaView edges={edges}>
            <View style={styles.header}>{header}</View>
          </SafeAreaView>
        </GradientSurface>
      ) : (
        <SafeAreaView edges={edges} style={headerStyle}>
          <View style={styles.header}>{header}</View>
        </SafeAreaView>
      )}
      {body}
    </View>
  );
}

const styles = StyleSheet.create({
  flex: {
    flex: 1,
  },
  content: {
    padding: spacing.lg,
    gap: spacing.md,
    paddingBottom: spacing.xl,
  },
  header: {
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.sm,
    paddingBottom: spacing.md,
  },
});
