import Ionicons from '@expo/vector-icons/Ionicons';
import { router, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { useCallback, useState } from 'react';
import { ActivityIndicator, Alert, Linking, Platform, StyleSheet, View } from 'react-native';

import { AppText, Button, Card, Screen } from '@/components/ui';
import { colors, hubColors, spacing } from '@/constants/theme';
import { useAdminOnlyScreen } from '@/lib/adminGate';
import {
  disconnectQbo,
  fetchQboStatus,
  planSupportsJobCosting,
  startQboConnect,
  type QboStatus,
} from '@/lib/quickbooks';

/**
 * `/quickbooks` (2026-10-14) — Systems Management → QuickBooks. Admin only.
 *
 * Connect sends the admin to Intuit's consent page; Intuit redirects to the
 * `qbo-oauth` function, which saves the connection and sends the browser back
 * here with ?connected=1 or ?error=…. Intuit's app settings also point their
 * Launch / Connect / Disconnect URLs here (Disconnect adds ?disconnected=1).
 *
 * The status card makes a live call to QuickBooks each time the screen opens,
 * so "Connected" means QuickBooks answered just now.
 */
export default function QuickBooksScreen() {
  const gate = useAdminOnlyScreen();
  const params = useLocalSearchParams<{ connected?: string; error?: string; disconnected?: string }>();
  const [status, setStatus] = useState<QboStatus | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState<'connect' | 'disconnect' | null>(null);
  const [notice, setNotice] = useState<{ kind: 'success' | 'error'; message: string } | null>(() => {
    if (params.error) return { kind: 'error', message: params.error };
    if (params.connected) return { kind: 'success', message: 'QuickBooks is connected.' };
    if (params.disconnected) return { kind: 'success', message: 'QuickBooks was disconnected from the app.' };
    return null;
  });

  const load = useCallback(async () => {
    setLoadError(null);
    const res = await fetchQboStatus();
    if (res.ok) setStatus(res.value);
    else setLoadError(res.message);
  }, []);

  useFocusEffect(
    useCallback(() => {
      if (gate.phase === 'ready' && gate.isAdmin) void load();
    }, [gate.phase, gate.isAdmin, load]),
  );

  const connect = async () => {
    setBusy('connect');
    setNotice(null);
    const res = await startQboConnect();
    setBusy(null);
    if (!res.ok) {
      setNotice({ kind: 'error', message: res.message });
      return;
    }
    if (Platform.OS === 'web' && typeof window !== 'undefined') {
      window.location.assign(res.value);
    } else {
      // On the phone the consent page opens in Safari and lands on the web
      // app's /quickbooks; reopening this screen shows the new state.
      void Linking.openURL(res.value);
    }
  };

  const doDisconnect = async () => {
    setBusy('disconnect');
    const res = await disconnectQbo();
    setBusy(null);
    if (!res.ok) {
      setNotice({ kind: 'error', message: res.message });
      return;
    }
    setNotice({ kind: 'success', message: 'QuickBooks was disconnected from the app.' });
    if (params.connected || params.error) router.setParams({ connected: undefined, error: undefined });
    void load();
  };

  const confirmDisconnect = () => {
    const message =
      'The app stops sending jobs, expenses, invoices and hours to QuickBooks until you connect again. Nothing already in QuickBooks is deleted.';
    if (Platform.OS === 'web') {
      if (typeof window !== 'undefined' && window.confirm(`Disconnect QuickBooks?\n\n${message}`)) void doDisconnect();
      return;
    }
    Alert.alert('Disconnect QuickBooks?', message, [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Disconnect', style: 'destructive', onPress: () => void doDisconnect() },
    ]);
  };

  if (gate.blocked) return null;
  if (gate.phase === 'loading' || (status === null && !loadError)) {
    return (
      <Screen edges={[]}>
        <ActivityIndicator color={hubColors.systems.fg} style={styles.loading} />
      </Screen>
    );
  }

  const connected = status?.connected === true;
  const sku = status?.offeringSku ?? null;

  return (
    <Screen edges={[]} contentContainerStyle={styles.content}>
      {notice ? (
        <Card style={[styles.notice, notice.kind === 'error' ? styles.noticeError : styles.noticeOk]}>
          <Ionicons
            name={notice.kind === 'error' ? 'alert-circle' : 'checkmark-circle'}
            size={20}
            color={notice.kind === 'error' ? colors.danger : colors.olive}
          />
          <AppText variant="body" style={styles.flex}>
            {notice.message}
          </AppText>
        </Card>
      ) : null}

      <Card style={styles.card}>
        <View style={styles.row}>
          <Ionicons
            name={connected ? 'checkmark-circle' : 'link-outline'}
            size={28}
            color={connected ? colors.olive : colors.textMuted}
          />
          <View style={styles.flex}>
            <AppText variant="heading">{connected ? 'Connected' : 'Not connected'}</AppText>
            <AppText variant="caption" color={colors.textSecondary}>
              {connected
                ? [status?.companyName, sku].filter(Boolean).join(' · ')
                : 'Connect the company QuickBooks Online account so the app can send jobs, expenses, invoices and hours to it.'}
            </AppText>
          </View>
        </View>

        {loadError ? (
          <AppText variant="caption" color={colors.danger}>
            {loadError}
          </AppText>
        ) : null}
        {!connected && status?.reason ? (
          <AppText variant="caption" color={colors.danger}>
            {status.reason}
          </AppText>
        ) : null}

        {connected ? (
          <View style={styles.details}>
            {status?.environment === 'sandbox' ? (
              <AppText variant="caption" color={colors.danger}>
                Test company (Intuit sandbox) — not the real books.
              </AppText>
            ) : null}
            {status?.connectedBy ? (
              <AppText variant="caption" color={colors.textMuted}>
                Connected by {status.connectedBy}
                {status.connectedAt
                  ? ` on ${new Date(status.connectedAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}`
                  : ''}
              </AppText>
            ) : null}
            {sku && !planSupportsJobCosting(sku) ? (
              <AppText variant="caption" color={colors.danger}>
                This plan cannot track profit per job. Upgrade to QuickBooks Plus for Projects and job costing.
              </AppText>
            ) : null}
          </View>
        ) : null}

        {connected ? (
          <Button
            label="Disconnect"
            variant="secondary"
            icon="unlink-outline"
            onPress={confirmDisconnect}
            loading={busy === 'disconnect'}
          />
        ) : (
          <Button
            label="Connect QuickBooks"
            icon="link"
            onPress={() => void connect()}
            loading={busy === 'connect'}
          />
        )}
      </Card>

      <AppText variant="caption" color={colors.textMuted} style={styles.footnote}>
        You approve the connection on Intuit's own page. The QuickBooks login is kept on the server only — it never
        reaches a phone or browser.
      </AppText>
    </Screen>
  );
}

const styles = StyleSheet.create({
  loading: { marginTop: spacing.xl },
  content: { gap: spacing.md, paddingBottom: spacing.xl },
  card: { gap: spacing.md },
  row: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  flex: { flex: 1 },
  details: { gap: spacing.xs },
  notice: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  noticeOk: { borderColor: colors.olive, borderWidth: 1 },
  noticeError: { borderColor: colors.danger, borderWidth: 1 },
  footnote: { paddingHorizontal: spacing.sm },
});
