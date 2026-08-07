import Ionicons from '@expo/vector-icons/Ionicons';
import { useRouter } from 'expo-router';
import { useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { colors, radii, shadows, spacing } from '@/constants/theme';
import { deleteOwnAccount } from '@/lib/account';
import { clearRoleCache } from '@/lib/role';
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
    | '/more/employees'
    | '/security';
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
  { href: '/security', title: 'Security & 2FA', icon: 'shield-checkmark' },
  // Visible to everyone; the screen itself is admin-gated.
  { href: '/more/employees', title: 'Employees', icon: 'id-card' },
];

export default function MoreScreen() {
  const router = useRouter();

  const [deleting, setDeleting] = useState(false);
  const [busy, setBusy] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const removeAccount = async () => {
    setBusy(true);
    setDeleteError(null);
    const result = await deleteOwnAccount();
    setBusy(false);
    if (result.ok) {
      clearRoleCache();
      router.replace('/');
    } else {
      setDeleteError(result.message);
    }
  };

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

        {/* Required by App Store guideline 5.1.1(v) for any app with accounts. */}
        {deleting ? (
          <View style={styles.dangerCard}>
            <Text style={styles.dangerTitle}>Delete your account?</Text>
            <Text style={styles.dangerBody}>
              This permanently removes your login and signs you out everywhere. It does not remove
              your employment record, or the jobs and hours you&apos;ve logged — the office keeps
              those. Ask Devon if you need those changed.
            </Text>
            {deleteError ? <Text style={styles.dangerError}>{deleteError}</Text> : null}
            <View style={styles.dangerRow}>
              <Pressable onPress={() => setDeleting(false)} disabled={busy} hitSlop={8}>
                <Text style={styles.cancelText}>Cancel</Text>
              </Pressable>
              <Pressable
                onPress={removeAccount}
                disabled={busy}
                style={({ pressed }) => [styles.deleteButton, pressed && styles.pressed]}>
                {busy ? (
                  <ActivityIndicator color={colors.white} />
                ) : (
                  <Text style={styles.deleteText}>Delete permanently</Text>
                )}
              </Pressable>
            </View>
          </View>
        ) : (
          <Pressable onPress={() => setDeleting(true)} hitSlop={8} style={styles.deleteLinkWrap}>
            <Text style={styles.deleteLink}>Delete my account</Text>
          </Pressable>
        )}
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
  deleteLinkWrap: { alignSelf: 'center', paddingVertical: spacing.sm },
  deleteLink: { color: colors.danger, fontSize: 14, fontWeight: '700' },
  dangerCard: {
    backgroundColor: colors.white,
    borderRadius: radii.md,
    borderWidth: 1,
    borderColor: colors.danger,
    padding: spacing.md,
    gap: spacing.sm,
  },
  dangerTitle: { color: colors.danger, fontSize: 15, fontWeight: '800' },
  dangerBody: { color: colors.inkSoft, fontSize: 13, lineHeight: 19 },
  dangerError: { color: colors.danger, fontSize: 13, fontWeight: '600' },
  dangerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'flex-end',
    gap: spacing.md,
  },
  cancelText: { color: colors.inkSoft, fontSize: 14, fontWeight: '700' },
  deleteButton: {
    backgroundColor: colors.danger,
    borderRadius: radii.pill,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm + 2,
  },
  deleteText: { color: colors.white, fontSize: 14, fontWeight: '800' },
  signOutText: {
    color: colors.danger,
  },
});
