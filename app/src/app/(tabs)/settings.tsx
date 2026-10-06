import { Redirect, useFocusEffect, useNavigation, useRouter } from 'expo-router';
import { useCallback, useState } from 'react';
import { StyleSheet, View } from 'react-native';

import BuildInfo from '@/components/BuildInfo';
import { DeleteAccount } from '@/components/DeleteAccount';
import { AppText, Card, ListRow, Screen, SectionHeader } from '@/components/ui';
import { colors, hubColors, spacing } from '@/constants/theme';
import { formatPhone } from '@/lib/comms';
import { useRoleGate } from '@/lib/role';
import { fetchMyLine } from '@/lib/salesHome';
import { signOutAndLeave } from '@/lib/signOut';

/**
 * The Settings tab (2026-10-06) — a sales rep's account screen, standing in
 * for the Menu tab they do not have.
 *
 *   Me        · name, email, their DC Solar number (read-only — an admin
 *               assigns numbers)
 *   Account   · Security (password, two-step sign-in), Sign out
 *   App       · version / check for an update, Delete my account
 *
 * More sections are being discussed with Carson (notifications, commission
 * history in S4, help). Admins and crew have the Menu tab; this one is hidden
 * from them and sends them there.
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

  useFocusEffect(
    useCallback(() => {
      let cancelled = false;
      void fetchMyLine().then((l) => {
        if (!cancelled) setLine(l);
      });
      return () => {
        cancelled = true;
      };
    }, []),
  );

  const me = gate.role;

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
