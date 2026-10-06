import { useNavigation } from 'expo-router';
import { useState } from 'react';
import { ActivityIndicator, StyleSheet, View } from 'react-native';

import { AnimatedPressable, AppText, Button, Card } from '@/components/ui';
import { colors, radii, spacing } from '@/constants/theme';
import { deleteOwnAccount } from '@/lib/account';
import { clearRoleCache } from '@/lib/role';
import { resetToLogin } from '@/lib/signOut';

/**
 * "Delete my account" — required by App Store guideline 5.1.1(v) for any app
 * with accounts. A quiet red link that opens a confirm card in place.
 *
 * Lifted out of Home (2026-10-06) so the Sales Settings tab carries the same
 * control: a rep has no Home Account section, and every login must be able
 * to find this.
 */
export function DeleteAccount() {
  const navigation = useNavigation();
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
      resetToLogin(navigation);
    } else {
      setDeleteError(result.message);
    }
  };

  if (!deleting) {
    return (
      <AnimatedPressable
        onPress={() => setDeleting(true)}
        hitSlop={8}
        accessibilityRole="button"
        style={styles.deleteLinkWrap}>
        <AppText variant="caption" color={colors.danger}>
          Delete my account
        </AppText>
      </AnimatedPressable>
    );
  }

  return (
    <Card tone="danger" style={styles.dangerCard}>
      <AppText variant="heading" color={colors.danger}>
        Delete your account?
      </AppText>
      <AppText variant="body" color={colors.textSecondary}>
        This permanently removes your login and signs you out everywhere. It does not remove your
        employment record, or the jobs and hours you&apos;ve logged — the office keeps those. Ask
        Devon if you need those changed.
      </AppText>
      {deleteError ? (
        <AppText variant="bodyStrong" color={colors.danger}>
          {deleteError}
        </AppText>
      ) : null}
      <View style={styles.dangerRow}>
        <Button label="Cancel" variant="ghost" size="sm" disabled={busy} onPress={() => setDeleting(false)} />
        {busy ? (
          <ActivityIndicator color={colors.danger} />
        ) : (
          <Button label="Delete permanently" variant="danger" size="sm" onPress={removeAccount} />
        )}
      </View>
    </Card>
  );
}

const styles = StyleSheet.create({
  dangerCard: {
    gap: spacing.sm,
    borderWidth: 1,
    borderColor: colors.danger,
    borderRadius: radii.md,
  },
  dangerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'flex-end',
    gap: spacing.md,
  },
  deleteLinkWrap: {
    alignSelf: 'center',
    paddingVertical: spacing.sm,
  },
});
