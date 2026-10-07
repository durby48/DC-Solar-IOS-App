import { Redirect, useFocusEffect, useNavigation, useRouter } from 'expo-router';
import { useCallback, useState } from 'react';
import { StyleSheet, View } from 'react-native';

import BuildInfo from '@/components/BuildInfo';
import { DeleteAccount } from '@/components/DeleteAccount';
import { AppText, Card, ListRow, Screen, SectionHeader } from '@/components/ui';
import { colors, hubColors, spacing } from '@/constants/theme';
import { formatPhone } from '@/lib/comms';
import { useRoleGate } from '@/lib/role';
import { fetchMyPrefs, hmLabel, type MyPrefs } from '@/lib/repSettings';
import { fetchMyLine } from '@/lib/salesHome';
import { signOutAndLeave } from '@/lib/signOut';

/**
 * The Settings tab (2026-10-06) — a sales rep's account screen, standing in
 * for the Menu tab they do not have.
 *
 *   Me        · name, email, their DC Solar number (read-only — an admin
 *               assigns numbers)
 *   Selling   · (manager: Assign leads), Sales resources, My commission, Lead map, Plans & prices,
 *               Saved texts
 *   Phone     · Recent calls, Do not disturb, Notifications, Calling check
 *   Account   · Security (password, two-step sign-in), Sign out
 *   App       · version / check for an update, Delete my account
 *   Developer · Developer Tools, for a developer on a Sales account (2026-10-08)
 *
 * Each row opens its own screen (`/commission`, `/lead-map`, `/plans`,
 * `/saved-texts`, `/recents`, `/do-not-disturb`, `/notifications`,
 * `/calling-check` — 2026-10-06/07). Admins
 * and crew have the Menu tab; this one is hidden from them and sends them
 * there.
 */
export default function SettingsTab() {
  const gate = useRoleGate();
  if (gate.phase === 'ready' && !gate.role?.isSales) return <Redirect href="/more" />;
  return <SalesSettings />;
}

function SalesSettings() {
  const router = useRouter();
  const navigation = useNavigation();
  const gate = useRoleGate();
  const [line, setLine] = useState<string | null>(null);
  const [prefs, setPrefs] = useState<MyPrefs | null>(null);

  useFocusEffect(
    useCallback(() => {
      let cancelled = false;
      void fetchMyLine().then((l) => {
        if (!cancelled) setLine(l);
      });
      void fetchMyPrefs().then((p) => {
        if (!cancelled) setPrefs(p);
      });
      return () => {
        cancelled = true;
      };
    }, []),
  );

  const me = gate.role;
  const go = (path: string) => router.push(path as never);

  return (
    <Screen contentContainerStyle={styles.content}>
      <AppText variant="title" color={colors.textPrimary}>
        Settings
      </AppText>

      <View>
        <SectionHeader title="Me" accent={hubColors.crm.fg} />
        <Card padded={false}>
          <ListRow icon="person" title={me?.displayName ?? 'Signed in'} subtitle={me?.email ?? undefined} chevron={false} divider />
          <ListRow
            icon="call"
            title={line ? formatPhone(line) : 'No number yet'}
            subtitle={line ? 'Your DC Solar number — calls and texts come from it' : 'Ask an admin to assign you one'}
            chevron={false}
          />
        </Card>
      </View>

      <View>
        <SectionHeader title="Selling" accent={hubColors.crm.fg} />
        <Card padded={false}>
          {/* The sales manager hands out leads in bulk (2026-10-08). */}
          {me?.isSalesManager || me?.isDeveloper ? (
            <ListRow icon="people" title="Assign leads" subtitle="Filter leads and hand them out to the team" onPress={() => go('/assign-leads')} divider />
          ) : null}
          <ListRow icon="library" title="Sales resources" subtitle="Brochure, call script, objections" onPress={() => go('/resources')} divider />
          <ListRow icon="cash" title="My commission" subtitle="This pay period and past ones" onPress={() => go('/commission')} divider />
          <ListRow icon="map" title="Lead map" subtitle="Your prospects and customers, pinned" onPress={() => go('/lead-map')} divider />
          <ListRow icon="pricetags" title="Plans & prices" subtitle="Bronze, Silver, Gold — what to quote" onPress={() => go('/plans')} divider />
          <ListRow icon="chatbubble-ellipses" title="Saved texts" subtitle="Ready-made texts, and your own" onPress={() => go('/saved-texts')} />
        </Card>
      </View>

      <View>
        <SectionHeader title="Phone" accent={hubColors.crm.fg} />
        <Card padded={false}>
          <ListRow icon="time" title="Recent calls" subtitle="Calls to and from your number" onPress={() => go('/recents')} divider />
          <ListRow
            icon="moon"
            title="Do not disturb"
            subtitle={prefs?.dndEnabled ? `On · calls ring ${hmLabel(prefs.workStart)}–${hmLabel(prefs.workEnd)}` : 'Off'}
            onPress={() => go('/do-not-disturb')}
            divider
          />
          <ListRow icon="notifications" title="Notifications" subtitle="Texts, missed calls, new prospects" onPress={() => go('/notifications')} divider />
          <ListRow icon="pulse" title="Calling check" subtitle="Make sure calls ring this phone" onPress={() => go('/calling-check')} />
        </Card>
      </View>

      {/* Developer tag (2026-10-08) — a developer on a Sales account has no Menu tab. */}
      {me?.isDeveloper ? (
        <View>
          <SectionHeader title="Developer" accent={hubColors.systems.fg} />
          <Card padded={false}>
            <ListRow
              icon="construct"
              iconColor={hubColors.systems.fg}
              iconBackground={hubColors.systems.bg}
              title="Developer Tools"
              subtitle="View as a role or a person, phone reports, view log"
              onPress={() => go('/dev-tools')}
            />
          </Card>
        </View>
      ) : null}

      <View>
        <SectionHeader title="Account" accent={hubColors.crm.fg} />
        <Card padded={false}>
          <ListRow
            icon="shield-checkmark"
            title="Security"
            subtitle="Password and two-step sign-in"
            onPress={() => router.push('/security' as never)}
            divider
          />
          <ListRow icon="log-out" title="Sign out" danger chevron={false} onPress={() => void signOutAndLeave(navigation)} />
        </Card>
      </View>

      <DeleteAccount />
      <BuildInfo />
    </Screen>
  );
}

const styles = StyleSheet.create({
  content: {
    width: '100%',
    maxWidth: 560,
    alignSelf: 'center',
    gap: spacing.md,
    paddingBottom: spacing.xl,
  },
});
