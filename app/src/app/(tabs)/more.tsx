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
} from '@/components/ui';
import { colors, hubColors, radii, spacing } from '@/constants/theme';
import { deleteOwnAccount } from '@/lib/account';
import { explainAdminOnly, isLockedFor } from '@/lib/adminGate';
import { fetchUnreadCount } from '@/lib/comms';
import { hubSections } from '@/lib/hub';
import { clearRoleCache, useRoleGate } from '@/lib/role';
import { resetToLogin, signOutAndLeave } from '@/lib/signOut';

/**
 * Menu — every screen in the app as a dense list.
 *
 * The same `lib/hub.ts` map Home draws as five tiles, drawn here as one
 * group of rows per hub (2026-09-12 overhaul), each group in its hub's
 * colour: the eyebrow bar and every icon square in the CRM group are CRM
 * purple, and so on. Home is for finding the thing you use every day; this
 * is for finding the thing you use twice a month.
 *
 * EVERY ROLE SEES EVERY ROW. Admin-only entries are drawn locked (lock glyph,
 * muted) and, on tap, explain that they need an administrator instead of
 * navigating — see `lib/adminGate.ts`. The lock is a courtesy, not a
 * boundary: the destinations still check for themselves and RLS still
 * decides what any query returns. Because the layout no longer depends on
 * the role there is no skeleton phase; the locks land when the role does.
 *
 * The file is still `more.tsx` and the route is still `/more`, because the
 * `more/*` directory has to keep working alongside it. Only the label is
 * "Menu".
 */
export default function MenuScreen() {
  const router = useRouter();
  const navigation = useNavigation();
  const gate = useRoleGate();
  const isAdmin = gate.phase === 'ready' && gate.role?.isAdmin === true;

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
      {hubSections().map(({ hub, items }) => {
        const accent = hubColors[hub.key];
        return (
          <View key={hub.key} style={styles.section}>
            <SectionHeader title={hub.title} subtitle={hub.subtitle} accent={accent.fg} />
            <Card padded={false}>
              {items.map((item, i) => {
                // Per ROW, the same rule as `hub/[key].tsx`: Receipts sits in
                // the (admin) Systems hub but is open to everyone.
                const locked = gate.phase === 'ready' && isLockedFor(item.gate, isAdmin);
                return (
                  <ListRow
                    key={item.key}
                    icon={item.icon}
                    iconColor={accent.fg}
                    iconBackground={accent.bg}
                    title={item.title}
                    subtitle={item.subtitle}
                    badge={item.badge === 'unread' ? unread : undefined}
                    divider={i < items.length - 1}
                    locked={locked}
                    onPress={() => {
                      if (isLockedFor(item.gate, isAdmin)) explainAdminOnly();
                      else router.push(item.href);
                    }}
                  />
                );
              })}
            </Card>
          </View>
        );
      })}

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
