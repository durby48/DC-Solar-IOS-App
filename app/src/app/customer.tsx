import Ionicons from '@expo/vector-icons/Ionicons';
import { useRouter } from 'expo-router';
import { useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { colors, radii, shadows, spacing } from '@/constants/theme';
import { deleteOwnAccount, getAccountInfo } from '@/lib/account';
import { clearRoleCache } from '@/lib/role';
import { supabase } from '@/lib/supabase';

/**
 * Where a CUSTOMER account lands. Customers deliberately have access to
 * nothing yet — their portal is a later project — so this is a holding screen
 * that confirms the account exists, plus sign-out and account deletion.
 *
 * The real barrier is RLS: a customer has no `employees` row, so every
 * company policy evaluates false for them. This screen is routing, not
 * security.
 */
export default function CustomerScreen() {
  const router = useRouter();
  const [email, setEmail] = useState<string | null>(null);
  const [name, setName] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    getAccountInfo().then((info) => {
      if (cancelled) return;
      // Staff who land here (or type the URL) belong in the app, not on a
      // dead-end screen; signed-out visitors go back to the login.
      if (info.kind === 'employee') {
        router.replace('/(tabs)');
        return;
      }
      if (info.kind === 'none') {
        router.replace('/');
        return;
      }
      setEmail(info.email);
      setName(info.fullName);
    });
    return () => {
      cancelled = true;
    };
  }, [router]);

  const signOut = async () => {
    await supabase.auth.signOut();
    clearRoleCache();
    router.replace('/');
  };

  const remove = async () => {
    setBusy(true);
    setError(null);
    const result = await deleteOwnAccount();
    setBusy(false);
    if (result.ok) {
      clearRoleCache();
      router.replace('/');
    } else {
      setError(result.message);
    }
  };

  return (
    <SafeAreaView style={styles.safe}>
      <ScrollView contentContainerStyle={styles.container}>
        <View style={styles.badge}>
          <Ionicons name="sunny" size={30} color={colors.sun} />
        </View>
        <Text style={styles.title}>You&apos;re signed up{name ? `, ${name}` : ''}</Text>
        <Text style={styles.body}>
          Your DC Solar account is active. The customer portal — your project updates, documents
          and referrals — isn&apos;t open yet. We&apos;ll email {email ?? 'you'} the moment it is.
        </Text>

        <View style={styles.card}>
          <Text style={styles.cardLabel}>Signed in as</Text>
          <Text style={styles.cardValue}>{email ?? '—'}</Text>
        </View>

        <Pressable
          onPress={signOut}
          style={({ pressed }) => [styles.primary, pressed && styles.pressed]}>
          <Text style={styles.primaryText}>Sign out</Text>
        </Pressable>

        {confirming ? (
          <View style={styles.dangerCard}>
            <Text style={styles.dangerTitle}>Delete this account?</Text>
            <Text style={styles.dangerBody}>
              This permanently removes your login and cannot be undone. You can sign up again at
              any time.
            </Text>
            <View style={styles.dangerRow}>
              <Pressable onPress={() => setConfirming(false)} disabled={busy} hitSlop={8}>
                <Text style={styles.cancelText}>Cancel</Text>
              </Pressable>
              <Pressable
                onPress={remove}
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
          <Pressable onPress={() => setConfirming(true)} hitSlop={8} style={styles.deleteLinkWrap}>
            <Text style={styles.deleteLink}>Delete my account</Text>
          </Pressable>
        )}

        {error ? <Text style={styles.error}>{error}</Text> : null}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.cream },
  container: {
    flexGrow: 1,
    justifyContent: 'center',
    alignItems: 'center',
    padding: spacing.lg,
    gap: spacing.md,
    maxWidth: 520,
    alignSelf: 'center',
  },
  badge: {
    width: 64,
    height: 64,
    borderRadius: 32,
    backgroundColor: colors.sunLight,
    alignItems: 'center',
    justifyContent: 'center',
  },
  title: { color: colors.ink, fontSize: 24, fontWeight: '800', textAlign: 'center' },
  body: {
    color: colors.inkSoft,
    fontSize: 15,
    lineHeight: 22,
    textAlign: 'center',
  },
  card: {
    alignSelf: 'stretch',
    backgroundColor: colors.white,
    borderRadius: radii.md,
    padding: spacing.md,
    gap: 2,
    ...shadows.card,
  },
  cardLabel: {
    color: colors.inkSoft,
    fontSize: 11,
    fontWeight: '800',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  cardValue: { color: colors.ink, fontSize: 15, fontWeight: '700' },
  primary: {
    alignSelf: 'stretch',
    backgroundColor: colors.sun,
    borderRadius: radii.pill,
    paddingVertical: spacing.md,
    alignItems: 'center',
    ...shadows.card,
  },
  primaryText: { color: colors.ink, fontSize: 16, fontWeight: '800' },
  pressed: { opacity: 0.8 },
  deleteLinkWrap: { paddingVertical: spacing.sm },
  deleteLink: { color: colors.danger, fontSize: 14, fontWeight: '700' },
  dangerCard: {
    alignSelf: 'stretch',
    backgroundColor: colors.white,
    borderRadius: radii.md,
    borderWidth: 1,
    borderColor: colors.danger,
    padding: spacing.md,
    gap: spacing.sm,
  },
  dangerTitle: { color: colors.danger, fontSize: 15, fontWeight: '800' },
  dangerBody: { color: colors.inkSoft, fontSize: 13, lineHeight: 19 },
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
  error: { color: colors.danger, fontSize: 13, fontWeight: '600', textAlign: 'center' },
});
