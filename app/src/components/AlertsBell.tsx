import Ionicons from '@expo/vector-icons/Ionicons';
import { router } from 'expo-router';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { colors } from '@/constants/theme';
import { useUnreadAlerts } from '@/lib/alerts';

/**
 * The bell (2026-11-08): opens Alerts — every push this person was sent —
 * with the live unread count on it. On Home and in the CRM.
 */
export function AlertsBell({ color = colors.ink, size = 24 }: { color?: string; size?: number }) {
  const unread = useUnreadAlerts();
  return (
    <Pressable
      onPress={() => router.push('/alerts' as never)}
      hitSlop={10}
      accessibilityRole="button"
      accessibilityLabel={unread > 0 ? `Alerts, ${unread} unread` : 'Alerts'}
      style={({ pressed }) => [styles.wrap, pressed && { opacity: 0.6 }]}>
      <Ionicons name={unread > 0 ? 'notifications' : 'notifications-outline'} size={size} color={color} />
      {unread > 0 ? (
        <View style={styles.badge}>
          <Text style={styles.badgeText}>{unread > 99 ? '99+' : String(unread)}</Text>
        </View>
      ) : null}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  wrap: { padding: 4 },
  badge: {
    position: 'absolute',
    top: -2,
    right: -4,
    minWidth: 18,
    height: 18,
    borderRadius: 9,
    paddingHorizontal: 4,
    backgroundColor: colors.danger,
    alignItems: 'center',
    justifyContent: 'center',
  },
  badgeText: { color: '#FFFFFF', fontSize: 11, fontWeight: '800' },
});
