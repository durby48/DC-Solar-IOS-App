import Ionicons from '@expo/vector-icons/Ionicons';
import { router, usePathname } from 'expo-router';
import { Pressable, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { colors } from '@/constants/theme';
import { useRoleGate } from '@/lib/role';

/**
 * The Keypad button (2026-10-09, Carson): a round button in the top-right
 * corner of every sales screen, opening the keypad. It replaced the Keypad tab
 * (that spot is the Lead map now). Not on the keypad itself, the live call, or
 * the public pages. Screens whose own buttons sit top-right leave
 * `KEYPAD_FAB_GUTTER` of room for it.
 */
export const KEYPAD_FAB_GUTTER = 52;

const HIDDEN = ['/keypad', '/call', '/brochure', '/join', '/card-saved', '/set-password', '/sign-up'];

export function KeypadFab() {
  const gate = useRoleGate();
  const pathname = usePathname();
  const insets = useSafeAreaInsets();

  if (gate.phase !== 'ready' || gate.role?.isSales !== true) return null;
  if (HIDDEN.some((p) => pathname === p || pathname.startsWith(`${p}/`))) return null;

  return (
    <View pointerEvents="box-none" style={[styles.layer, { top: insets.top + 6 }]}>
      <Pressable
        onPress={() => router.push('/keypad' as never)}
        accessibilityRole="button"
        accessibilityLabel="Open the keypad"
        hitSlop={6}
        style={({ pressed }) => [styles.button, pressed && styles.pressed]}>
        <Ionicons name="keypad" size={18} color={colors.textOnAction} />
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  layer: { position: 'absolute', right: 10, zIndex: 150 },
  button: {
    width: 38,
    height: 38,
    borderRadius: 19,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.sun,
    shadowColor: '#000',
    shadowOpacity: 0.3,
    shadowRadius: 6,
    shadowOffset: { width: 0, height: 2 },
    elevation: 6,
  },
  pressed: { opacity: 0.6 },
});
