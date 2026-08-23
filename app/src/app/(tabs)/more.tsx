import { useFocusEffect, useNavigation, useRouter } from 'expo-router';
import { useCallback, useState } from 'react';
import { ActivityIndicator, StyleSheet, View } from 'react-native';

import BuildInfo from '@/components/BuildInfo';
import {
  AnimatedPressable,
  AppText,
  Button,
  Card,
  ListRow,
  Screen,
  SectionHeader,
  SkeletonList,
} from '@/components/ui';
import { colors, radii, spacing } from '@/constants/theme';
import { deleteOwnAccount } from '@/lib/account';
import { fetchUnreadCount } from '@/lib/comms';
import { visibleGroups, visibleItems } from '@/lib/hub';
import { clearRoleCache, useRoleGate } from '@/lib/role';
import { resetToLogin, signOutAndLeave } from '@/lib/signOut';

/**
 * Menu — every screen in the app as a dense list.
 *
 * The same `lib/hub.ts` data Home draws as tiles, drawn here as rows: Home is
 * for finding the thing you use every day, this is for finding the thing you
 * use twice a month. Keeping one list means a new screen appears in both
 * places, gated the same way, from a single edit.
 *
 * WHAT CHANGED. This screen used to hand-maintain an `ITEMS` array with a
 * literal union of every href, and it had NO role gating at all: every crew
 * member was offered Employees, Employee of the Month, and (once they moved
 * out of the tab bar) Financials and Sales — screens that then told them they
 * couldn't look. `visibleItems` fixes that. The gate is a courtesy, not a
 * boundary; the destinations still check for themselves and RLS still decides
 * what any query returns.
 *
 * The file is still `more.tsx` and the route is still `/more`, because the
 * `more/*` directory has to keep working alongside it. Only the label is
 * "Menu".
 */
export default function MenuScreen() {
  const router = useRouter();
  const navigation = useNavigation();
  const gate = useRoleGate();
  const isAdmin = gate.role?.isAdmin ?? false;

  const [deleting, setDeleting] = useState(false);
  const [busy, setBusy] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  /**
   * Unread inbound texts. `messages` is admin-only in RLS, so this comes back
   * as 0 for the crew and no badge appears — the gate is the database's, not
   * this screen's.
   */
  const [unread, setUnread] = useState(0);

  useFocusEffect(
    useCallback(() => {
      let cancelled = false;
      void fetchUnreadCount().then((count) => {
        if (!cancelled) setUnread(count);
      });
      return () => {
        cancelled = true;
      };
    }, []),
  );

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

  // Shared helper: ends the session (with a timeout) and resets the ROOT
  // stack to the login route. `router.replace('/')` from inside the tabs
  // resolves to the Home tab, which is why the old button looked dead.
  const signOut = () => signOutAndLeave(navigation);

  return (
    <Screen header={<AppText variant="title">Menu</AppText>}>
      {gate.phase === 'loading' ? (
        <SkeletonList count={6} height={54} />
      ) : (
        visibleGroups(isAdmin).map((group) => {
          const items = visibleItems(isAdmin, group.key);
          return (
            <View key={group.key} style={styles.section}>
              <SectionHeader title={group.title} subtitle={group.subtitle} />
              <Card padded={false}>
                {items.map((item, i) => (
                  <ListRow
                    key={item.key}
                    icon={item.icon}
                    title={item.title}
                    badge={item.badge === 'unread' ? unread : undefined}
                    divider={i < items.length - 1}
                    onPress={() => router.push(item.href)}
                  />
                ))}
              </Card>
            </View>
          );
        })
      )}

      <Card padded={false} style={styles.section}>
        <ListRow icon="log-out" title="Sign out" danger chevron={false} onPress={signOut} />
      </Card>

      {/* Required by App Store guideline 5.1.1(v) for any app with accounts. */}
      {deleting ? (
        <Card tone="danger" style={styles.dangerCard}>
          <AppText variant="heading" color={colors.danger}>
            Delete your account?
          </AppText>
          <AppText variant="body" color={colors.textSecondary}>
            This permanently removes your login and signs you out everywhere. It does not remove
            your employment record, or the jobs and hours you&apos;ve logged — the office keeps
            those. Ask Devon if you need those changed.
          </AppText>
          {deleteError ? (
            <AppText variant="bodyStrong" color={colors.danger}>
              {deleteError}
            </AppText>
          ) : null}
          <View style={styles.dangerRow}>
            <Button
              label="Cancel"
              variant="ghost"
              size="sm"
              disabled={busy}
              onPress={() => setDeleting(false)}
            />
            {busy ? (
              <ActivityIndicator color={colors.danger} />
            ) : (
              <Button
                label="Delete permanently"
                variant="danger"
                size="sm"
                onPress={removeAccount}
              />
            )}
          </View>
        </Card>
      ) : (
        <AnimatedPressable
          onPress={() => setDeleting(true)}
          hitSlop={8}
          accessibilityRole="button"
          style={styles.deleteLinkWrap}>
          <AppText variant="caption" color={colors.danger}>
            Delete my account
          </AppText>
        </AnimatedPressable>
      )}

      {/* Which build + OTA update this device runs; tap to check for a newer one. */}
      <BuildInfo />
    </Screen>
  );
}

const styles = StyleSheet.create({
  section: {
    marginTop: spacing.sm,
  },
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
