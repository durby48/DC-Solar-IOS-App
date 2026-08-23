import Ionicons from '@expo/vector-icons/Ionicons';
import { useNavigation, useRouter } from 'expo-router';
import { useEffect, useState } from 'react';
import { ActivityIndicator, StyleSheet, View } from 'react-native';

import {
  AnimatedPressable,
  AppText,
  Button,
  Card,
  EmptyState,
  FadeInUp,
  ListRow,
  Screen,
  SectionHeader,
  SkeletonList,
  StatTile,
} from '@/components/ui';
import { colors, radii, spacing } from '@/constants/theme';
import {
  deleteOwnAccount,
  fetchCustomerPortal,
  getAccountInfo,
  type CustomerDocument,
  type CustomerProject,
} from '@/lib/account';
import {
  clearBounceToLogin,
  hasBouncedToLogin,
  markBouncedToLogin,
} from '@/lib/authGate';
import { getDocumentUrl } from '@/lib/data';
import { viewDocument } from '@/lib/pdf';
import { clearRoleCache } from '@/lib/role';
import { supabase } from '@/lib/supabase';

/**
 * Where a CUSTOMER account lands: their projects, their paperwork, what they
 * owe, and the two account controls the App Store requires.
 *
 * The real barrier is RLS: a customer has no `employees` row, so every
 * company policy evaluates false for them. This screen is routing, not
 * security.
 */
export default function CustomerScreen() {
  const router = useRouter();
  const navigation = useNavigation();
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

  /**
   * Who is looking at this screen, and should they be?
   *
   * ──────────────────────────────────────────────────────────────────────
   * THE PING-PONG THIS FIXES (2026-08-23)
   * ──────────────────────────────────────────────────────────────────────
   * This effect used to ask `getAccountInfo()` first and treat `kind: 'none'`
   * as "signed-out visitor → `router.replace('/')`". But `'none'` is NOT
   * "no session": it is also what a signed-in account with neither an
   * `employees` row nor a `customer_accounts` row gets — and `landingRoute()`
   * sends exactly that account HERE, on purpose (the portal is the documented
   * safe landing spot for anything it cannot classify). So `app/index.tsx`
   * saw a session and routed to `/customer`, this screen saw `'none'` and
   * bounced to `/`, the login routed again… for ever. Two REST calls per hop
   * made it slower than the old tabs loop, but on web it still ends in
   * Chrome's `Throttling navigation to prevent the browser from hanging`
   * (crbug.com/1038223).
   *
   * The fix is the same shape as `(tabs)/_layout.tsx::useStaffGate`, and for
   * the same reason — the two screens must test OPPOSITE facts so they can
   * never both fire:
   *
   *   - The SESSION is checked first. No session is a fact, not a failed
   *     lookup, and it is the ONLY thing that bounces to the login. It
   *     short-circuits without a single REST call. `app/index.tsx` routes
   *     away only when `getSession()` returns one, so a visitor bounced there
   *     gets the form, full stop.
   *   - With a session, `getAccountInfo()` decides only whether to hand staff
   *     to the crew tabs. `'customer'`, `'none'` and `'unknown'` all STAY —
   *     identical to `landingRoute()`, so what the login chose is what this
   *     screen accepts. An unlinked account just sees an empty portal, which
   *     is what `my_projects` / `my_documents` / `my_balance` return for it.
   *
   * The bounce itself is `navigation.reset()` on the root stack rather than
   * `router.replace('/')`, because `/` is claimed by both `app/index.tsx` and
   * `app/(tabs)/index.tsx`; naming the `index` ROUTE cannot mis-resolve, and
   * the reset is idempotent. The `authGate` flag and the holstered fallback
   * are the tabs gate's, reused verbatim — see the comment block there.
   */
  useEffect(() => {
    let cancelled = false;

    const leave = () => {
      // Was a previous bounce never acknowledged by the login screen? Then we
      // are looping, and the fallback below must not fire.
      const unacknowledged = hasBouncedToLogin();
      markBouncedToLogin();
      try {
        navigation.reset({ index: 0, routes: [{ name: 'index' as never }] });
      } catch {
        // Only if the root navigator has no `index` route to reset to — which
        // should never happen. Once, and never while a bounce is already
        // unaccounted for.
        if (!unacknowledged) router.replace('/');
      }
    };

    void (async () => {
      // Session FIRST. A missing session is not a failed lookup.
      const { data } = await supabase.auth.getSession();
      if (cancelled) return;
      if (!data.session) {
        leave();
        return;
      }
      // Somebody is signed in, so the next sign-out gets a clean slate even if
      // the login screen never mounted to clear it.
      clearBounceToLogin();

      const info = await getAccountInfo();
      if (cancelled) return;
      // Staff who land here (or type the URL) belong in the app, not on a
      // dead-end screen. Everyone else with a session stays — including
      // 'none' (no customer link yet) and 'unknown' (offline) — and just sees
      // an empty portal.
      if (info.kind === 'employee') {
        router.replace('/(tabs)');
        return;
      }
      setEmail(info.email);
      setName(info.fullName);
      const portal = await fetchCustomerPortal();
      if (cancelled) return;
      if (portal) {
        setProjects(portal.projects);
        setDocuments(portal.documents as CustomerDocument[]);
        setBalance(portal.balance);
      }
      setLoaded(true);
    })();

    return () => {
      cancelled = true;
    };
  }, [router, navigation]);

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

  const empty = projects.length === 0 && documents.length === 0;

  return (
    <Screen contentContainerStyle={styles.container}>
      <View style={styles.hero}>
        <View style={styles.badge}>
          <Ionicons name="sunny" size={30} color={colors.accentAction} />
        </View>
        <AppText variant="title" align="center">
          Welcome{name ? `, ${name}` : ''}
        </AppText>
      </View>

      {!loaded ? (
        <SkeletonList count={3} height={72} />
      ) : empty ? (
        <Card>
          <EmptyState
            icon="sunny-outline"
            title="Your DC Solar account is active"
            body="Once we start work on your project, your estimates, invoices and payments will appear here."
          />
        </Card>
      ) : (
        <>
          {balance ? (
            <FadeInUp index={0}>
              <View style={styles.balanceRow}>
                <StatTile
                  label="Invoiced"
                  value={Math.round(balance.invoiced)}
                  prefix="$"
                  tone={0}
                  compact
                  style={styles.balanceTile}
                />
                <StatTile
                  label="Paid"
                  value={Math.round(balance.paid)}
                  prefix="$"
                  tone={6}
                  compact
                  style={styles.balanceTile}
                />
                <StatTile
                  label="Balance"
                  value={Math.round(balance.balance)}
                  prefix="$"
                  tone={balance.balance > 0 ? 4 : 'olive'}
                  compact
                  style={styles.balanceTile}
                />
              </View>
            </FadeInUp>
          ) : null}

          {projects.length > 0 ? (
            <View style={styles.section}>
              <SectionHeader title="Your projects" icon="home-outline" />
              <Card padded={false}>
                {projects.map((p, index) => (
                  <FadeInUp key={p.job_id} index={index}>
                    <ListRow
                      icon="home"
                      title={p.name ?? p.job_number ?? 'Project'}
                      subtitle={p.address ?? undefined}
                      divider={index < projects.length - 1}
                      chevron={false}
                      right={
                        p.stage ? (
                          <AppText variant="caption" color={colors.accentPrimary}>
                            {p.stage}
                          </AppText>
                        ) : null
                      }
                    />
                  </FadeInUp>
                ))}
              </Card>
            </View>
          ) : null}

          {documents.length > 0 ? (
            <View style={styles.section}>
              <SectionHeader title="Estimates, invoices & payments" icon="document-text-outline" />
              <Card padded={false}>
                {documents.map((d, index) => {
                  const stale = d.pdf_state === 'stale';
                  const revision = d.revision ?? 1;
                  const hasPdf = Boolean(d.document_path);
                  const opening = openingDoc === d.entry_id;
                  const subtitle = [
                    d.job_number,
                    d.occurred_on,
                    // Shown, not hidden: the numbers below are current even
                    // when the stored PDF hasn't caught up.
                    stale && hasPdf ? '(PDF being updated)' : null,
                  ]
                    .filter(Boolean)
                    .join(' · ');
                  return (
                    <FadeInUp key={d.entry_id} index={index}>
                      <ListRow
                        icon={d.type === 'payment' ? 'cash' : 'document-text'}
                        title={`${
                          d.document_number ??
                          d.type.charAt(0).toUpperCase() + d.type.slice(1)
                        }${revision > 1 ? ` · rev ${revision}` : ''}`}
                        subtitle={subtitle || undefined}
                        divider={index < documents.length - 1}
                        disabled={!hasPdf || openingDoc !== null}
                        onPress={hasPdf ? () => void openDocument(d) : undefined}
                        chevron={hasPdf && !opening}
                        right={
                          <View style={styles.docRight}>
                            <AppText
                              variant="bodyStrong"
                              color={d.type === 'payment' ? colors.mintDeep : colors.textPrimary}
                              style={styles.amount}>
                              {`$${Math.round(d.amount).toLocaleString('en-US')}`}
                            </AppText>
                            {opening ? (
                              <ActivityIndicator size="small" color={colors.accentPrimary} />
                            ) : null}
                          </View>
                        }
                      />
                    </FadeInUp>
                  );
                })}
              </Card>
              {docError ? (
                <AppText variant="caption" color={colors.danger} align="center">
                  {docError}
                </AppText>
              ) : null}
            </View>
          ) : null}
        </>
      )}

      <Card>
        <AppText variant="section" color={colors.textMuted}>
          Signed in as
        </AppText>
        <AppText variant="bodyStrong">{email ?? '—'}</AppText>
      </Card>

      <Button label="Sign out" size="lg" fullWidth onPress={signOut} />

      {/* Required by App Store guideline 5.1.1(v) for any app with accounts. */}
      {confirming ? (
        <Card tone="danger" style={styles.dangerCard}>
          <AppText variant="heading" color={colors.danger}>
            Delete this account?
          </AppText>
          <AppText variant="body" color={colors.textSecondary}>
            This permanently removes your login and cannot be undone. You can sign up again at any
            time.
          </AppText>
          <View style={styles.dangerRow}>
            <Button
              label="Cancel"
              variant="ghost"
              size="sm"
              disabled={busy}
              onPress={() => setConfirming(false)}
            />
            <Button
              label="Delete permanently"
              variant="danger"
              size="sm"
              loading={busy}
              onPress={remove}
            />
          </View>
        </Card>
      ) : (
        <AnimatedPressable
          onPress={() => setConfirming(true)}
          haptic="tapLight"
          hitSlop={8}
          accessibilityRole="button"
          style={styles.deleteLinkWrap}>
          <AppText variant="caption" color={colors.danger}>
            Delete my account
          </AppText>
        </AnimatedPressable>
      )}

      {error ? (
        <AppText variant="caption" color={colors.danger} align="center">
          {error}
        </AppText>
      ) : null}
    </Screen>
  );
}

const styles = StyleSheet.create({
  container: {
    maxWidth: 560,
    width: '100%',
    alignSelf: 'center',
  },
  hero: {
    alignItems: 'center',
    gap: spacing.sm,
    paddingBottom: spacing.xs,
  },
  badge: {
    width: 64,
    height: 64,
    borderRadius: radii.pill,
    backgroundColor: colors.sunLight,
    alignItems: 'center',
    justifyContent: 'center',
  },
  balanceRow: {
    flexDirection: 'row',
    gap: spacing.sm,
  },
  /**
   * `StatTile`'s own `minWidth: 120` would total 376pt across three tiles and
   * overflow a 375pt phone. The row decides the width here — same trick Home
   * uses on its tile grid.
   */
  balanceTile: {
    minWidth: 0,
  },
  section: {
    marginTop: spacing.sm,
    gap: spacing.xs,
  },
  docRight: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
  },
  amount: {
    fontVariant: ['tabular-nums'],
  },
  dangerCard: {
    gap: spacing.sm,
    borderWidth: 1,
    borderColor: colors.danger,
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
