import Ionicons from '@expo/vector-icons/Ionicons';
import type { ReactNode } from 'react';
import {
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';

import { colors, radii, shadows, spacing } from '@/constants/theme';
import { useMotion } from '@/lib/motion';

/** Ink at 45%, the same scrim `WheelPickerSheet` uses. */
const SCRIM = 'rgba(61,53,46,0.45)';

/**
 * A bottom sheet for a form: dark scrim, grip, title, close ×, and a
 * scrolling body that gives way to the keyboard.
 *
 * The Contacts tab used to open its editor INLINE under the row, which
 * scrolled the row off the top of a long directory the moment the keyboard
 * came up. A sheet keeps the form in one place, works the same for a
 * contact, a customer and a crew member's own cell number, and closes the
 * way every other sheet in the app closes — tap the scrim, the ×, or Cancel.
 *
 * Children own their Save / Cancel buttons; the sheet only frames them.
 */
export function EditorSheet({
  visible,
  title,
  onClose,
  children,
}: {
  visible: boolean;
  title: string;
  onClose: () => void;
  children: ReactNode;
}) {
  const motion = useMotion();
  return (
    <Modal
      visible={visible}
      transparent
      animationType={motion.enabled ? 'slide' : 'none'}
      statusBarTranslucent
      onRequestClose={onClose}>
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        style={styles.scrimRoot}>
        <Pressable
          style={StyleSheet.absoluteFill}
          onPress={onClose}
          accessibilityRole="button"
          accessibilityLabel={`Close ${title}`}
        />
        <View style={styles.sheet}>
          <View style={styles.grip} />
          <View style={styles.titleRow}>
            <Text style={styles.title} numberOfLines={1}>
              {title}
            </Text>
            <Pressable
              onPress={onClose}
              hitSlop={10}
              accessibilityRole="button"
              accessibilityLabel="Close"
              style={({ pressed }) => [styles.close, pressed && styles.pressed]}>
              <Ionicons name="close" size={20} color={colors.inkSoft} />
            </Pressable>
          </View>
          <ScrollView
            style={styles.body}
            contentContainerStyle={styles.bodyContent}
            keyboardShouldPersistTaps="handled"
            showsVerticalScrollIndicator={false}>
            {children}
          </ScrollView>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  scrimRoot: {
    flex: 1,
    justifyContent: 'flex-end',
    backgroundColor: SCRIM,
  },
  sheet: {
    width: '100%',
    // A phone app that also runs at desktop widths: cap the sheet so a
    // 27" monitor does not get a mile-wide form.
    maxWidth: 560,
    maxHeight: '92%',
    alignSelf: 'center',
    backgroundColor: colors.surface,
    borderTopLeftRadius: radii.lg,
    borderTopRightRadius: radii.lg,
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.sm,
    paddingBottom: spacing.xl,
    gap: spacing.sm,
    ...shadows.raised,
  },
  grip: {
    width: 44,
    height: 4,
    borderRadius: radii.pill,
    backgroundColor: colors.borderStrong,
    alignSelf: 'center',
  },
  titleRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  title: { flex: 1, color: colors.ink, fontSize: 17, fontWeight: '800' },
  close: { padding: spacing.xs },
  body: { flexGrow: 0 },
  bodyContent: { paddingBottom: spacing.sm },
  pressed: { opacity: 0.6 },
});
