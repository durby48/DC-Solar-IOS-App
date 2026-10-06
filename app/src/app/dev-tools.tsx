import * as Clipboard from 'expo-clipboard';
import { Stack, useFocusEffect, useRouter } from 'expo-router';
import { useCallback, useState } from 'react';
import { ActivityIndicator, Linking, Platform, Pressable, StyleSheet, View } from 'react-native';

import BuildInfo from '@/components/BuildInfo';
import { AppText, Button, Card, Chip, ListRow, Screen, SectionHeader } from '@/components/ui';
import { colors, hubColors, spacing } from '@/constants/theme';
import {
  fetchPeople,
  fetchPhoneEvents,
  fetchPhoneReports,
  fetchViewLog,
  leaveDevView,
  sendTestPush,
  startPersonView,
  startRoleView,
  type PhoneEvent,
  type PhoneReport,
  type PickPerson,
  type ViewLogEntry,
} from '@/lib/devView';
import { getDevView, ROLE_LABELS, type ViewRole } from '@/lib/devViewState';
import { appVersionLabel, runtimeLabel } from '@/lib/diagnostics';
import { useRoleGate } from '@/lib/role';

/**
 * `/dev-tools` — Developer Tools (2026-10-08), for people with the Developer
 * tag (Menu for admins/crew, Settings for a sales account).
 *
 *   View as a role     the screens of Owner / Operator / Crew / Sales /
 *                      Sales manager, with your own data (actions are real)
 *   View as a person   their screens AND data, look-only — saves, texts and
 *                      calls answer "could they?" and nothing is kept
 *   Phone reports      each person's app version / update, last seen, and
 *                      recent problems (lib/diagnostics.ts)
 *   View log           who viewed as whom, and when
 *   Test tools, This app, Dashboards
 *
 * How the look-only view works: lib/supabase.ts + 2026-10-08_developer.sql.
 */
const ROLES: ViewRole[] = ['owner', 'operator', 'viewer', 'sales', 'sales_manager'];

const DASHBOARDS: { title: string; subtitle: string; url: string }[] = [
  { title: 'Supabase', subtitle: 'Database, functions, logs', url: 'https://supabase.com/dashboard/project/kjamxfezsathrsbztiln' },
  { title: 'Vercel', subtitle: 'The website (app.dcsolarkc.com)', url: 'https://vercel.com/dashboard' },
  { title: 'Expo', subtitle: 'iPhone builds and updates', url: 'https://expo.dev' },
  { title: 'Stripe', subtitle: 'Cards, plans, payments', url: 'https://dashboard.stripe.com' },
  { title: 'Twilio', subtitle: 'Numbers, texts, calls', url: 'https://console.twilio.com' },
];

function ago(iso: string | null): string {
  if (!iso) return 'never';
  const mins = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.round(mins / 60);
  if (hours < 48) return `${hours} h ago`;
  return `${Math.round(hours / 24)} days ago`;
}

function when(iso: string): string {
  const d = new Date(iso);
  return (
    d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) +
    ', ' +
    d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
  );
}

function eventLine(e: PhoneEvent): string {
  const d = e.detail ?? {};
  const pick = (k: string) => (d[k] == null ? null : String(d[k]));
  const parts: string[] = [];
  if (e.kind === 'request_error') parts.push(`${pick('method') ?? ''} ${pick('path') ?? ''} → ${pick('status') ?? ''}`.trim());
  else if (pick('message')) parts.push(pick('message') as string);
  else if (pick('error')) parts.push(pick('error') as string);
  else if (e.kind === 'app_open') parts.push(`${e.appVersion ?? ''} · update ${e.runtime ?? ''}`);
  return parts.join(' ') || Object.entries(d).slice(0, 3).map(([k, v]) => `${k}: ${String(v)}`).join(' · ');
}

export default function DevToolsScreen() {
  const gate = useRoleGate();
  const view = getDevView();

  if (view?.kind === 'person') {
    return (
      <Screen edges={[]} contentContainerStyle={styles.content}>
        <Stack.Screen options={{ title: 'Developer Tools' }} />
        <Card style={styles.gap}>
          <AppText variant="heading">You&apos;re viewing as {view.name}</AppText>
          <AppText variant="body" color={colors.textSecondary}>
            Look-only: you see their screens and their information, and nothing you do is saved or sent. Developer
            Tools opens in your own view.
          </AppText>
          <Button label="Back to my view" onPress={() => void leaveDevView()} />
        </Card>
      </Screen>
    );
  }
  if (gate.phase === 'loading') {
    return (
      <Screen edges={[]}>
        <Stack.Screen options={{ title: 'Developer Tools' }} />
        <ActivityIndicator color={colors.accentPrimary} style={styles.loading} />
      </Screen>
    );
  }
  if (!gate.role?.isDeveloper) {
    return (
      <Screen edges={[]} contentContainerStyle={styles.content}>
        <Stack.Screen options={{ title: 'Developer Tools' }} />
        <AppText variant="body" color={colors.textSecondary}>
          Developer Tools are for developers.
        </AppText>
      </Screen>
    );
  }
  return <Tools myEmail={gate.role.email.toLowerCase()} myName={gate.role.displayName} realRole={gate.role.realRole} />;
}

function Tools({ myEmail, myName, realRole }: { myEmail: string; myName: string | null; realRole: ViewRole }) {
  const router = useRouter();
  const view = getDevView();
  const [people, setPeople] = useState<PickPerson[] | null>(null);
  const [reports, setReports] = useState<PhoneReport[] | null>(null);
  const [log, setLog] = useState<ViewLogEntry[] | null>(null);
  const [openReport, setOpenReport] = useState<string | null>(null);
  const [events, setEvents] = useState<PhoneEvent[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [status, setStatus] = useState<{ ok: boolean; text: string } | null>(null);

  useFocusEffect(
    useCallback(() => {
      void fetchPeople().then(setPeople);
      void fetchPhoneReports().then(setReports);
      void fetchViewLog().then(setLog);
    }, []),
  );

  const run = async (key: string, job: () => Promise<{ ok: true } | { ok: false; message: string }>) => {
    setBusy(key);
    setStatus(null);
    const result = await job();
    // On success the app restarts into the new view; only failures land here.
    if (!result.ok) {
      setBusy(null);
      setStatus({ ok: false, text: result.message });
    }
  };

  const toggleReport = (email: string) => {
    if (openReport === email) {
      setOpenReport(null);
      return;
    }
    setOpenReport(email);
    setEvents(null);
    void fetchPhoneEvents(email).then(setEvents);
  };

  const copyDiagnostics = async () => {
    const lines = [
      `DC Solar app — ${myName ?? myEmail} <${myEmail}> · ${ROLE_LABELS[realRole] ?? realRole} · developer`,
      `Version ${appVersionLabel()} · update ${runtimeLabel()}`,
      `${Platform.OS} ${String(Platform.Version ?? '')}`,
      `Copied ${new Date().toISOString()}`,
    ];
    await Clipboard.setStringAsync(lines.join('\n'));
    setStatus({ ok: true, text: 'Diagnostics copied.' });
  };

  const currentRole = view?.kind === 'role' ? view.role : null;

  return (
    <Screen edges={[]} contentContainerStyle={styles.content}>
      <Stack.Screen options={{ title: 'Developer Tools' }} />

      {status ? (
        <AppText variant="bodyStrong" color={status.ok ? colors.success : colors.danger}>
          {status.text}
        </AppText>
      ) : null}

      <View>
        <SectionHeader title="View as a role" subtitle="Their screens and menus — your own data, real actions" accent={hubColors.systems.fg} />
        <Card style={styles.gap}>
          <View style={styles.chips}>
            <Chip
              label="My normal view"
              tone="sun"
              selected={!currentRole}
              disabled={busy !== null}
              onPress={() => {
                if (currentRole) void run('normal', async () => (await leaveDevView(), { ok: true as const }));
              }}
            />
            {ROLES.map((r) => (
              <Chip
                key={r}
                label={ROLE_LABELS[r]}
                tone="ocean"
                selected={currentRole === r}
                disabled={busy !== null}
                onPress={() => {
                  if (currentRole !== r) void run(`role:${r}`, () => startRoleView(r));
                }}
              />
            ))}
          </View>
          {busy?.startsWith('role:') || busy === 'normal' ? <ActivityIndicator color={colors.accentPrimary} /> : null}
        </Card>
      </View>

      <View>
        <SectionHeader title="View as a person" subtitle="Exactly what they see — look-only" accent={hubColors.systems.fg} />
        <Card padded={false}>
          {!people ? (
            <ActivityIndicator color={colors.accentPrimary} style={styles.loading} />
          ) : (
            people
              .filter((p) => p.email.toLowerCase() !== myEmail)
              .map((p, i, list) => (
                <ListRow
                  key={p.email}
                  icon="eye"
                  iconColor={hubColors.systems.fg}
                  iconBackground={hubColors.systems.bg}
                  title={p.name}
                  subtitle={`${ROLE_LABELS[p.role] ?? p.role}${p.isTest ? ' · test account' : ''}`}
                  right={busy === `person:${p.email}` ? <ActivityIndicator color={colors.accentPrimary} /> : undefined}
                  disabled={busy !== null}
                  onPress={() => void run(`person:${p.email}`, () => startPersonView(p.email))}
                  divider={i < list.length - 1}
                />
              ))
          )}
        </Card>
      </View>

      <View>
        <SectionHeader title="Phone reports" subtitle="App version, last seen, and recent problems" accent={hubColors.systems.fg} />
        <Card padded={false}>
          {!reports ? (
            <ActivityIndicator color={colors.accentPrimary} style={styles.loading} />
          ) : (
            reports.map((r, i) => (
              <View key={r.email}>
                <ListRow
                  icon={r.platform === 'web' ? 'desktop' : 'phone-portrait'}
                  iconColor={hubColors.systems.fg}
                  iconBackground={hubColors.systems.bg}
                  title={r.name}
                  subtitle={
                    r.lastSeen
                      ? `${r.platform ?? '?'} · ${r.appVersion ?? '?'} · update ${r.runtime ?? '?'} · ${ago(r.lastSeen)}`
                      : 'No reports yet'
                  }
                  right={
                    <AppText variant="caption" color={r.problems7d > 0 ? colors.danger : colors.textSecondary}>
                      {r.problems7d > 0 ? `${r.problems7d} problem${r.problems7d === 1 ? '' : 's'}` : 'OK'}
                    </AppText>
                  }
                  chevron={false}
                  onPress={() => toggleReport(r.email)}
                  divider={i < reports.length - 1 || openReport === r.email}
                />
                {openReport === r.email ? (
                  <View style={styles.events}>
                    {!events ? (
                      <ActivityIndicator color={colors.accentPrimary} />
                    ) : events.length === 0 ? (
                      <AppText variant="caption" color={colors.textSecondary}>
                        Nothing recorded yet. Reports start once their app has this update.
                      </AppText>
                    ) : (
                      events.map((e) => (
                        <View key={e.id} style={styles.event}>
                          <AppText variant="caption" color={e.ok === false ? colors.danger : colors.textSecondary}>
                            {when(e.createdAt)} · {e.kind.replace('_', ' ')}
                            {e.ok === false ? ' · failed' : ''}
                          </AppText>
                          <AppText variant="caption" color={colors.textPrimary} numberOfLines={3}>
                            {eventLine(e)}
                          </AppText>
                        </View>
                      ))
                    )}
                  </View>
                ) : null}
              </View>
            ))
          )}
        </Card>
      </View>

      <View>
        <SectionHeader title="View log" subtitle="Every time someone used View as" accent={hubColors.systems.fg} />
        <Card padded={false}>
          {!log ? (
            <ActivityIndicator color={colors.accentPrimary} style={styles.loading} />
          ) : log.length === 0 ? (
            <AppText variant="body" color={colors.textSecondary} style={styles.empty}>
              Nobody has used View as yet.
            </AppText>
          ) : (
            log.map((l, i) => {
              const who = people?.find((p) => p.email.toLowerCase() === l.developerEmail.toLowerCase())?.name ?? l.developerEmail;
              const what =
                l.kind === 'person'
                  ? `viewed as ${l.targetName ?? '?'}`
                  : `switched the screens to ${l.targetRole ? (ROLE_LABELS[l.targetRole] ?? l.targetRole) : '?'}`;
              const mins = l.endedAt
                ? Math.max(1, Math.round((new Date(l.endedAt).getTime() - new Date(l.startedAt).getTime()) / 60000))
                : null;
              return (
                <ListRow
                  key={l.id}
                  icon={l.kind === 'person' ? 'eye' : 'color-wand'}
                  iconColor={hubColors.systems.fg}
                  iconBackground={hubColors.systems.bg}
                  title={`${who} ${what}`}
                  subtitle={`${when(l.startedAt)} · ${mins ? `${mins} min` : 'still on, or closed without leaving'}`}
                  chevron={false}
                  divider={i < log.length - 1}
                />
              );
            })
          )}
        </Card>
      </View>

      <View>
        <SectionHeader title="Test tools" accent={hubColors.systems.fg} />
        <Card padded={false}>
          <ListRow
            icon="notifications"
            iconColor={hubColors.systems.fg}
            iconBackground={hubColors.systems.bg}
            title="Send me a test notification"
            subtitle="To every phone you're signed in on"
            right={busy === 'push' ? <ActivityIndicator color={colors.accentPrimary} /> : undefined}
            onPress={async () => {
              setBusy('push');
              const r = await sendTestPush();
              setBusy(null);
              setStatus(r.ok ? { ok: true, text: 'Test notification sent — it should arrive in a few seconds.' } : { ok: false, text: r.message });
            }}
            divider
          />
          <ListRow
            icon="pulse"
            iconColor={hubColors.systems.fg}
            iconBackground={hubColors.systems.bg}
            title="Calling check"
            subtitle="Make sure calls ring this phone"
            onPress={() => router.push('/calling-check' as never)}
            divider
          />
          <ListRow
            icon="copy"
            iconColor={hubColors.systems.fg}
            iconBackground={hubColors.systems.bg}
            title="Copy diagnostics"
            subtitle="This device's version and update, to paste into a chat"
            chevron={false}
            onPress={() => void copyDiagnostics()}
          />
        </Card>
      </View>

      <View>
        <SectionHeader title="This app" accent={hubColors.systems.fg} />
        <BuildInfo />
      </View>

      <View>
        <SectionHeader title="Dashboards" accent={hubColors.systems.fg} />
        <Card padded={false}>
          {DASHBOARDS.map((d, i) => (
            <ListRow
              key={d.title}
              icon="open"
              iconColor={hubColors.systems.fg}
              iconBackground={hubColors.systems.bg}
              title={d.title}
              subtitle={d.subtitle}
              onPress={() => void Linking.openURL(d.url)}
              divider={i < DASHBOARDS.length - 1}
            />
          ))}
        </Card>
      </View>

      <Pressable onPress={() => router.back()} style={styles.footer}>
        <AppText variant="caption" color={colors.textSecondary}>
          Only people with the Developer tag see this. Add or remove it in Employees.
        </AppText>
      </Pressable>
    </Screen>
  );
}

const styles = StyleSheet.create({
  content: { width: '100%', maxWidth: 640, alignSelf: 'center', gap: spacing.md, paddingBottom: 140 },
  loading: { marginVertical: spacing.lg },
  gap: { gap: spacing.sm },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  empty: { padding: spacing.md },
  events: { paddingHorizontal: spacing.md, paddingVertical: spacing.sm, gap: spacing.sm, backgroundColor: colors.surfaceAlt },
  event: { gap: 2 },
  footer: { alignItems: 'center', paddingVertical: spacing.sm },
});
