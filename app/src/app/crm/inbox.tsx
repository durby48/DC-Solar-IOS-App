import Ionicons from '@expo/vector-icons/Ionicons';
import { Stack, useRouter } from 'expo-router';
import { Pressable, StyleSheet, View } from 'react-native';

import { Inbox } from '@/components/comms/Inbox';
import { colors } from '@/constants/theme';
import { useAdminOnlyScreen } from '@/lib/adminGate';

/**
 * `/crm/inbox` — the shared inbox under its own Stack header.
 *
 * The body is `components/comms/Inbox.tsx`, which the Phone section's
 * Messages tab renders too. This file is the header and nothing else, on
 * purpose: one thread list, two doors. Deep links to `/crm/inbox` keep
 * working unchanged.
 */
export default function InboxScreen() {
  const router = useRouter();
  // Admin-only, like the phone section that also mounts this inbox: a deep
  // link gets the "contact your administrator" alert and goes back.
  const gate = useAdminOnlyScreen();

  if (gate.blocked) {
    return (
      <>
        <Stack.Screen options={{ title: 'Messages' }} />
        <View style={styles.blank} />
      </>
    );
  }

  return (
    <>
      <Stack.Screen
        options={{
          title: 'Messages',
          headerRight: () => (
            <Pressable
              onPress={() => router.push('/crm/settings')}
              hitSlop={8}
              accessibilityLabel="Messaging settings"
              style={({ pressed }) => pressed && styles.pressed}>
              <Ionicons name="settings-outline" size={20} color={colors.ocean} />
            </Pressable>
          ),
        }}
      />
      <Inbox />
    </>
  );
}

const styles = StyleSheet.create({
  pressed: { opacity: 0.6 },
  blank: { flex: 1, backgroundColor: colors.surfaceAlt },
});
