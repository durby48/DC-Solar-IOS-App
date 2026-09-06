import Ionicons from '@expo/vector-icons/Ionicons';
import { Stack, useRouter } from 'expo-router';
import { Pressable, StyleSheet } from 'react-native';

import { Inbox } from '@/components/comms/Inbox';
import { colors } from '@/constants/theme';

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
});
