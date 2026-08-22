import Ionicons from '@expo/vector-icons/Ionicons';
import { useRouter } from 'expo-router';
import { useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { colors, radii, shadows, spacing } from '@/constants/theme';
import {
  deleteOwnAccount,
  fetchCustomerPortal,
  getAccountInfo,
  type CustomerDocument,
  type CustomerProject,
} from '@/lib/account';
import { getDocumentUrl } from '@/lib/data';
import { viewDocument } from '@/lib/pdf';
import { clearRoleCache } from '@/lib/role';
import { supabase } from '@/lib/supabase';

/**
 * Where a CUSTOMER account lands. Customers deliberately have access to
 * nothing yet — their portal is a later project — so this is a holding screen
 * that confirms the account exists, plus sign-out and account deletion.
 *
 * The real barrier is RLS: a customer has no `employees` row, so every
 * company policy evaluates false for them. This screen is routing, not
 * security.
 */
export default function CustomerScreen() {
  const router = useRouter();
  const [email, setEmail] = useState<string | null>(null);
  const [name, setName] = useState<string | null>(null);
  const [projects, setProjects] = useState<CustomerProject[]>([]);
  const [documents, setDocuments] = useState<CustomerDocument[]>([]);
  const [docError, setDocError] = useState<string | null>(null);
  const [openingDoc, setOpeningDoc] = useState<string | null>(null);
  const [balance, setBalance] = useState<{ invoiced: number; paid: number; balance: number } | null>(
    null,
  );
  const [loaded, setLoaded] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    getAccountInfo().then((info) => {
      if (cancelled) return;
      // Staff who land here (or type the URL) belong in the app, not on a
      // dead-end screen; signed-out visitors go back to the login.
      if (info.kind === 'employee') {
        router.replace('/(tabs)');
        return;
      }
      if (info.kind === 'none') {
        router.replace('/');
        return;
      }
      // 'unknown' (offline) stays put and just shows an empty portal.
      setEmail(info.email);
      setName(info.fullName);
      fetchCustomerPortal().then((portal) => {
        if (cancelled || !portal) {
          setLoaded(true);
          return;
        }
        setProjects(portal.projects);
        setDocuments(portal.documents as CustomerDocument[]);
        setBalance(portal.balance);
        setLoaded(true);
      });
    });
    return () => {
      cancelled = true;
    };
  }, [router]);

  /**
   * Open one of the customer's own PDFs.
   *
   * `revision` goes on the signed URL as a cache-buster because a revised
   * document overwrites the same storage object. Two thirds of the legacy
   * document rows point at ops-console paths with NO object in the bucket, so
   * the signed URL mints fine and the fetch 404s — hence the explicit
   * "isn't available yet" message rather than a silent dead tap.
   */
  const openDocument = async (doc: CustomerDocument) => {
    if (!doc.document_path) return;
    setDocError(null);
    setOpeningDoc(doc.entry_id);
    try {
      const url = await getDocumentUrl(doc.document_path, doc.revision ?? null);
      if (!url || !(await viewDocument(url))) {
        setDocError("This PDF isn't available yet — ask the office.");
      }
    } catch {
      setDocError("This PDF isn't available yet — ask the office.");
    } finally {
      setOpeningDoc(null);
    }
  };

  const signOut = async () => {
    await supabase.auth.signOut();
    clearRoleCache();
    router.replace('/');
  };

  const remove = async () => {
    setBusy(true);
    setError(null);
    const result = await deleteOwnAccount();
    setBusy(false);
    if (result.ok) {
      clearRoleCache();
      router.replace('/');
    } else {
      setError(result.message);
    }
  };

  return (
    <SafeAreaView style={styles.safe}>
      <ScrollView contentContainerStyle={styles.container}>
        <View style={styles.badge}>
          <Ionicons name="sunny" size={30} color={colors.sun} />
        </View>
        <Text style={styles.title}>Welcome{name ? `, ${name}` : ''}</Text>

        {!loaded ? (
          <ActivityIndicator color={colors.ocean} />
        ) : projects.length === 0 && documents.length === 0 ? (
          <Text style={styles.body}>
            Your DC Solar account is active. Once we start work on your project, your estimates,
            invoices and payments will appear here.
          </Text>
        ) : (
          <>
            {balance ? (
              <View style={styles.balanceRow}>
                {([
                  ['Invoiced', balance.invoiced],
                  ['Paid', balance.paid],
                  ['Balance', balance.balance],
                ] as [string, number][]).map(([label, value], i) => (
                  <View key={label} style={styles.balanceTile}>
                    <Text style={styles.cardLabel}>{label}</Text>
                    <Text style={[styles.balanceValue, i === 2 && value > 0 && styles.owing]}>
                      {`$${Math.round(value).toLocaleString('en-US')}`}
                    </Text>
                  </View>
                ))}
              </View>
            ) : null}

            {projects.length > 0 ? (
              <View style={styles.section}>
                <Text style={styles.sectionTitle}>Your projects</Text>
                {projects.map((p) => (
                  <View key={p.job_id} style={styles.listRow}>
                    <View style={styles.listBody}>
                      <Text style={styles.listTitle} numberOfLines={2}>
                        {p.name ?? p.job_number ?? 'Project'}
                      </Text>
                      {p.address ? (
                        <Text style={styles.listMeta} numberOfLines={1}>
                          {p.address}
                        </Text>
                      ) : null}
                    </View>
                    <Text style={styles.listStage}>{p.stage ?? ''}</Text>
                  </View>
                ))}
              </View>
            ) : null}

            {documents.length > 0 ? (
              <View style={styles.section}>
                <Text style={styles.sectionTitle}>Estimates, invoices &amp; payments</Text>
                {documents.map((d) => {
                  const stale = d.pdf_state === 'stale';
                  const revision = d.revision ?? 1;
                  const hasPdf = Boolean(d.document_path);
                  return (
                    <Pressable
                      key={d.entry_id}
                      onPress={() => (hasPdf ? void openDocument(d) : undefined)}
                      disabled={!hasPdf || openingDoc !== null}
                      style={({ pressed }) => [
                        styles.listRow,
                        pressed && hasPdf && styles.rowPressed,
                      ]}>
                      <View style={styles.listBody}>
                        <Text style={styles.listTitle}>
                          {d.document_number ??
                            d.type.charAt(0).toUpperCase() + d.type.slice(1)}
                          {revision > 1 ? ` · rev ${revision}` : ''}
                        </Text>
                        <Text style={styles.listMeta}>
                          {[
                            d.job_number,
                            d.occurred_on,
                            // Shown, not hidden: the numbers below are current
                            // even when the stored PDF hasn't caught up.
                            stale && hasPdf ? '(PDF being updated)' : null,
                          ]
                            .filter(Boolean)
                            .join(' · ')}
                        </Text>
                      </View>
                      <Text style={[styles.listAmount, d.type === 'payment' && styles.paidAmount]}>
                        {`$${Math.round(d.amount).toLocaleString('en-US')}`}
                      </Text>
                      {hasPdf ? (
                        openingDoc === d.entry_id ? (
                          <ActivityIndicator size="small" color={colors.ocean} />
                        ) : (
                          <Ionicons name="chevron-forward" size={18} color={colors.ocean} />
                        )
                      ) : null}
                    </Pressable>
                  );
                })}
                {docError ? <Text style={styles.error}>{docError}</Text> : null}
              </View>
            ) : null}
          </>
        )}

        <View style={styles.card}>
          <Text style={styles.cardLabel}>Signed in as</Text>
          <Text style={styles.cardValue}>{email ?? '—'}</Text>
        </View>

        <Pressable
          onPress={signOut}
          style={({ pressed }) => [styles.primary, pressed && styles.pressed]}>
          <Text style={styles.primaryText}>Sign out</Text>
        </Pressable>

        {confirming ? (
          <View style={styles.dangerCard}>
            <Text style={styles.dangerTitle}>Delete this account?</Text>
            <Text style={styles.dangerBody}>
              This permanently removes your login and cannot be undone. You can sign up again at
              any time.
            </Text>
            <View style={styles.dangerRow}>
              <Pressable onPress={() => setConfirming(false)} disabled={busy} hitSlop={8}>
                <Text style={styles.cancelText}>Cancel</Text>
              </Pressable>
              <Pressable
                onPress={remove}
                disabled={busy}
                style={({ pressed }) => [styles.deleteButton, pressed && styles.pressed]}>
                {busy ? (
                  <ActivityIndicator color={colors.white} />
                ) : (
                  <Text style={styles.deleteText}>Delete permanently</Text>
                )}
              </Pressable>
            </View>
          </View>
        ) : (
          <Pressable onPress={() => setConfirming(true)} hitSlop={8} style={styles.deleteLinkWrap}>
            <Text style={styles.deleteLink}>Delete my account</Text>
          </Pressable>
        )}

        {error ? <Text style={styles.error}>{error}</Text> : null}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.cream },
  container: {
    flexGrow: 1,
    justifyContent: 'center',
    alignItems: 'center',
    padding: spacing.lg,
    gap: spacing.md,
    maxWidth: 520,
    alignSelf: 'center',
  },
  badge: {
    width: 64,
    height: 64,
    borderRadius: 32,
    backgroundColor: colors.sunLight,
    alignItems: 'center',
    justifyContent: 'center',
  },
  title: { color: colors.ink, fontSize: 24, fontWeight: '800', textAlign: 'center' },
  body: {
    color: colors.inkSoft,
    fontSize: 15,
    lineHeight: 22,
    textAlign: 'center',
  },
  card: {
    alignSelf: 'stretch',
    backgroundColor: colors.white,
    borderRadius: radii.md,
    padding: spacing.md,
    gap: 2,
    ...shadows.card,
  },
  cardLabel: {
    color: colors.inkSoft,
    fontSize: 11,
    fontWeight: '800',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  cardValue: { color: colors.ink, fontSize: 15, fontWeight: '700' },
  balanceRow: { flexDirection: 'row', alignSelf: 'stretch', gap: spacing.sm },
  balanceTile: {
    flex: 1,
    backgroundColor: colors.white,
    borderRadius: radii.md,
    padding: spacing.md,
    gap: 2,
    ...shadows.card,
  },
  balanceValue: {
    color: colors.ink,
    fontSize: 18,
    fontWeight: '800',
    fontVariant: ['tabular-nums'],
  },
  owing: { color: colors.coralDeep },
  section: {
    alignSelf: 'stretch',
    backgroundColor: colors.white,
    borderRadius: radii.md,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    ...shadows.card,
  },
  sectionTitle: {
    color: colors.inkSoft,
    fontSize: 11,
    fontWeight: '800',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    paddingVertical: spacing.sm,
  },
  listRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingVertical: spacing.sm,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.line,
  },
  rowPressed: { opacity: 0.6 },
  listBody: { flex: 1, gap: 2 },
  listTitle: { color: colors.ink, fontSize: 14, fontWeight: '700' },
  listMeta: { color: colors.inkSoft, fontSize: 12, fontWeight: '600' },
  listStage: { color: colors.ocean, fontSize: 12, fontWeight: '800' },
  listAmount: {
    color: colors.ink,
    fontSize: 14,
    fontWeight: '800',
    fontVariant: ['tabular-nums'],
  },
  paidAmount: { color: colors.mintDeep },
  primary: {
    alignSelf: 'stretch',
    backgroundColor: colors.sun,
    borderRadius: radii.pill,
    paddingVertical: spacing.md,
    alignItems: 'center',
    ...shadows.card,
  },
  primaryText: { color: colors.ink, fontSize: 16, fontWeight: '800' },
  pressed: { opacity: 0.8 },
  deleteLinkWrap: { paddingVertical: spacing.sm },
  deleteLink: { color: colors.danger, fontSize: 14, fontWeight: '700' },
  dangerCard: {
    alignSelf: 'stretch',
    backgroundColor: colors.white,
    borderRadius: radii.md,
    borderWidth: 1,
    borderColor: colors.danger,
    padding: spacing.md,
    gap: spacing.sm,
  },
  dangerTitle: { color: colors.danger, fontSize: 15, fontWeight: '800' },
  dangerBody: { color: colors.inkSoft, fontSize: 13, lineHeight: 19 },
  dangerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'flex-end',
    gap: spacing.md,
  },
  cancelText: { color: colors.inkSoft, fontSize: 14, fontWeight: '700' },
  deleteButton: {
    backgroundColor: colors.danger,
    borderRadius: radii.pill,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm + 2,
  },
  deleteText: { color: colors.white, fontSize: 14, fontWeight: '800' },
  error: { color: colors.danger, fontSize: 13, fontWeight: '600', textAlign: 'center' },
});
