import Ionicons from '@expo/vector-icons/Ionicons';
import { Stack, useLocalSearchParams } from 'expo-router';
import { StyleSheet, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { AppText, Card } from '@/components/ui';
import { colors, spacing } from '@/constants/theme';

/**
 * Where a CUSTOMER lands after the Stripe card page (2026-10-05, B2) —
 * `stripe-card-link` sends them to app.dcsolarkc.com/card-saved?status=saved
 * (or =cancelled when they back out).
 *
 * Public on purpose: the person here is a customer with no DC Solar login.
 * It reads nothing and writes nothing — the card itself is recorded by
 * `stripe-webhook` when Stripe reports it, not by this page loading.
 */
export default function CardSavedScreen() {
  const { status } = useLocalSearchParams<{ status?: string }>();
  const saved = status !== 'cancelled';

  return (
    <SafeAreaView style={styles.safe}>
      <Stack.Screen options={{ title: 'DC Solar', headerShown: false }} />
      <View style={styles.center}>
        <Card style={styles.card}>
          <Ionicons
            name={saved ? 'checkmark-circle' : 'close-circle-outline'}
            size={44}
            color={saved ? colors.olive : colors.inkSoft}
          />
          <AppText variant="title" align="center">
            {saved ? 'Your card is saved' : 'No card was saved'}
          </AppText>
          <AppText variant="body" align="center" color={colors.textSecondary}>
            {saved
              ? 'Thank you. DC Solar only charges it for your annual service plan after your visit is done. You can close this page.'
              : 'That is fine — your DC Solar representative can send you a new link whenever you are ready.'}
          </AppText>
        </Card>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.surfaceAlt },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: spacing.lg },
  card: { maxWidth: 440, width: '100%', alignItems: 'center', gap: spacing.md, padding: spacing.xl },
});
