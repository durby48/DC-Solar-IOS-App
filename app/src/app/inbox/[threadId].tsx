import Ionicons from '@expo/vector-icons/Ionicons';
import { Stack, useLocalSearchParams } from 'expo-router';
import { useEffect, useState } from 'react';
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';

import { ThreadView } from '@/components/email';
import { EmptyState } from '@/components/ui';
import { colors, hubColors, radii, shadows, spacing } from '@/constants/theme';
import { fetchLabels, type MailLabel } from '@/lib/gmail';
import { useRoleGate } from '@/lib/role';

/**
 * `/inbox/[threadId]` — one conversation, full screen (phones, and any
 * window under 900 px). The reader itself is `components/email/ThreadView`,
 * shared with the wide inbox's reading pane: messages oldest-first with
 * expand/collapse, attachments to download, Reply / Reply all / Forward
 * into the composer, and Archive / Star / Mark unread / Trash / Move to
 * label in the toolbar. All of it is Gmail's own state; nothing is stored.
 */
export default function EmailThreadScreen() {
  const { threadId } = useLocalSearchParams<{ threadId: string }>();
  const { phase, role } = useRoleGate();
  const [labels, setLabels] = useState<MailLabel[]>([]);

  useEffect(() => {
    if (phase !== 'ready' || !role?.isAdmin) return;
    let cancelled = false;
    void fetchLabels().then((result) => {
      if (!cancelled && result.ok) setLabels(result.labels);
    });
    return () => {
      cancelled = true;
    };
  }, [phase, role?.isAdmin]);

  const screen = (body: React.ReactNode) => (
    <>
      <Stack.Screen options={{ title: 'Conversation' }} />
      {body}
    </>
  );

  if (phase === 'loading') {
    return screen(
      <View style={[styles.screen, styles.center]}>
        <ActivityIndicator color={hubColors.crm.fg} />
      </View>,
    );
  }

  if (!role?.isAdmin) {
    return screen(
      <View style={[styles.screen, styles.padded]}>
        <View style={styles.card}>
          <View style={styles.badge}>
            <Ionicons name="lock-closed" size={26} color={hubColors.crm.fg} />
          </View>
          <Text style={styles.cardTitle}>{role ? 'Admins only' : 'Sign in to read email'}</Text>
          <Text style={styles.cardBody}>Email is limited to signed-in owners and operators.</Text>
        </View>
      </View>,
    );
  }

  if (!threadId) {
    return screen(
      <View style={styles.screen}>
        <EmptyState icon="mail-outline" title="Nothing to show" body="No conversation was selected." />
      </View>,
    );
  }

  return screen(
    <View style={styles.screen}>
      <ThreadView
        threadId={threadId}
        labels={labels}
        onLabelCreated={(label) => setLabels((prev) => [...prev, label])}
      />
    </View>,
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.surfaceAlt },
  center: { alignItems: 'center', justifyContent: 'center' },
  padded: { padding: spacing.lg },
  card: {
    backgroundColor: colors.white,
    borderRadius: radii.md,
    padding: spacing.lg,
    alignItems: 'center',
    gap: spacing.sm,
    ...shadows.card,
  },
  badge: {
    width: 52,
    height: 52,
    borderRadius: 26,
    backgroundColor: hubColors.crm.bg,
    alignItems: 'center',
    justifyContent: 'center',
  },
  cardTitle: { color: colors.ink, fontSize: 17, fontWeight: '800', textAlign: 'center' },
  cardBody: { color: colors.inkSoft, fontSize: 14, fontWeight: '600', textAlign: 'center' },
});
