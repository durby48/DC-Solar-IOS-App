import Ionicons from '@expo/vector-icons/Ionicons';
import { useRouter } from 'expo-router';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { colors, radii, shadows, spacing } from '@/constants/theme';
import { supabase } from '@/lib/supabase';

type IconName = keyof typeof Ionicons.glyphMap;

const ITEMS: {
  href:
    | '/more/time-off'
    | '/more/paystubs'
    | '/more/inventory'
    | '/more/checklist'
    | '/more/receipts'
    | '/more/customers'
    | '/more/monitoring'
    | '/more/employees';
  title: string;
  icon: IconName;
}[] = [
  { href: '/more/time-off', title: 'Time Off', icon: 'airplane' },
  { href: '/more/paystubs', title: 'Paystubs', icon: 'cash' },
  { href: '/more/inventory', title: 'Inventory', icon: 'cube' },
  { href: '/more/checklist', title: 'Vehicle Checklist', icon: 'clipboard' },
  { href: '/more/receipts', title: 'Receipts', icon: 'receipt' },
  { href: '/more/customers', title: 'Customers', icon: 'people' },
  { href: '/more/monitoring', title: 'Monitoring Logins', icon: 'pulse' },
  // Visible to everyone; the screen itself is admin-gated.
  { href: '/more/employees', title: 'Employees', icon: 'id-card' },
];

export default function MoreScreen() {
  const router = useRouter();

  const signOut = async () => {
    try {
      await supabase.auth.signOut();
    } catch {
      // Ignore — demo mode has no session.
    }
    router.replace('/');
  };

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      <ScrollView contentContainerStyle={styles.container}>
        <Text style={styles.title}>More</Text>

        <View style={styles.card}>
          {ITEMS.map((item, i) => (
            <Pressable
              key={item.href}
              onPress={() => router.push(item.href)}
              style={({ pressed }) => [
                styles.row,
                i < ITEMS.length - 1 && styles.rowBorder,
                pressed && styles.pressed,
              ]}>
              <View style={styles.iconWrap}>
                <Ionicons name={item.icon} size={18} color={colors.ocean} />
              </View>
              <Text style={styles.rowText}>{item.title}</Text>
              <Ionicons name="chevron-forward" size={18} color={colors.inkSoft} />
            </Pressable>
          ))}
        </View>

        <View style={styles.card}>
          <Pressable
            onPress={signOut}
            style={({ pressed }) => [styles.row, pressed && styles.pressed]}>
            <View style={styles.iconWrap}>
              <Ionicons name="log-out" size={18} color={colors.danger} />
            </View>
            <Text style={[styles.rowText, styles.signOutText]}>Sign out</Text>
          </Pressable>
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: {
    flex: 1,
    backgroundColor: colors.cream,
  },
  container: {
    padding: spacing.lg,
    gap: spacing.md,
  },
  title: {
    color: colors.ink,
    fontSize: 28,
    fontWeight: '800',
  },
  card: {
    backgroundColor: colors.white,
    borderRadius: radii.md,
    overflow: 'hidden',
    ...shadows.card,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.md,
  },
  rowBorder: {
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.tan,
  },
  pressed: {
    backgroundColor: colors.skySoft,
  },
  iconWrap: {
    width: 32,
    height: 32,
    borderRadius: radii.sm,
    backgroundColor: colors.skySoft,
    alignItems: 'center',
    justifyContent: 'center',
  },
  rowText: {
    flex: 1,
    color: colors.ink,
    fontSize: 16,
    fontWeight: '600',
  },
  signOutText: {
    color: colors.danger,
  },
});
