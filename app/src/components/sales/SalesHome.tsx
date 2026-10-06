import Ionicons from '@expo/vector-icons/Ionicons';
import { useFocusEffect, useRouter } from 'expo-router';
import { useCallback, useRef, useState } from 'react';
import { ActivityIndicator, StyleSheet, View } from 'react-native';

import { HomeHeader } from '@/components/HomeHeader';
import { AnimatedPressable, AppText, Button, Card, FadeInUp, ListRow, Screen } from '@/components/ui';
import { colors, hubColors, radii, spacing } from '@/constants/theme';
import { formatPhone, useCommsRealtime } from '@/lib/comms';
import { formatCents } from '@/lib/servicePlans';
import { useRole } from '@/lib/role';
import { fetchSalesHome, type SalesHomeData, type TodayItem } from '@/lib/salesHome';
import { inAppCallingSupported } from '@/lib/voice';

/**
 * The Sales Home (2026-10-06): one screen, nothing to scroll past.
 *
 *   greeting + their DC Solar number (in the header)
 *   [ 3  Today              › ]   visits, appointments, tasks due — opens in place
 *   [ 8  Prospects to call  › ]   → the CRM's Prospects list
 *   [ 40 On your lead map   › ]   → /lead-map (2026-10-07)
 *   [ 2  New messages       › ]   missed calls + unread texts — only when > 0
 *   [ + New prospect ]
 *
 * Carson cut the first version (pipeline tiles, number card, inline lists,
 * Account section) as too cluttered: one number per box, and the lists are a
 * tap away. Account (Security, Sign out, Delete) lives on the Settings tab.
 * The fourth box: commission this pay period → /commission (S4).
 *
 * Every read is RLS-scoped to the rep's own records (`lib/salesHome.ts`).
 */
export function SalesHome() {
  const router = useRouter();
  const role = useRole();
  const [data, setData] = useState<SalesHomeData | null>(null);
  const [openBox, setOpenBox] = useState<'today' | 'messages' | null>(null);
  const [callNotice, setCallNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    setData(await fetchSalesHome(role?.email ?? null, role?.isSalesManager === true));
  }, [role?.email, role?.isSalesManager]);

  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );

  // A text or call arriving while Home is open: one trailing reload per burst.
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useCommsRealtime(
    useCallback(() => {
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => {
        timer.current = null;
        void load();
      }, 1500);
    }, [load]),
  );

  const open = (key: string | null) => {
    if (key) router.navigate({ pathname: '/workspace', params: { open: key } } as never);
  };

  const callBack = (phone: string, name: string) => {
    if (!inAppCallingSupported()) {
      // Never the phone's own dialer: it would show their PERSONAL number.
      setCallNotice('Calls from your DC Solar number work in the DC Solar app or at app.dcsolarkc.com.');
      return;
    }
    router.push({ pathname: '/call', params: { to: phone, name } } as never);
  };

  const messages = data ? data.missed.length + data.unread.length : 0;
  const toggle = (box: 'today' | 'messages') => setOpenBox((current) => (current === box ? null : box));

  return (
    <Screen padded={false} edges={[]} contentContainerStyle={styles.scroll}>
      <HomeHeader line={data?.line ? formatPhone(data.line) : null} />

      <View style={styles.body}>
        {!data ? (
          <ActivityIndicator color={hubColors.crm.fg} style={styles.loading} />
        ) : (
          <>
            <FadeInUp index={0}>
              <Box
                count={data.today.length}
                label="Today"
                icon="today"
                tint={hubColors.operations}
                open={openBox === 'today'}
                onPress={() => toggle('today')}
              />
              {openBox === 'today' ? (
                <Card padded={false} style={styles.drawer}>
                  {data.today.length === 0 ? (
                    <AppText variant="body" color={colors.textSecondary} style={styles.empty}>
                      Nothing booked and no tasks due today.
                    </AppText>
                  ) : (
                    data.today.map((item, i) => (
                      <ListRow
                        key={item.key}
                        icon={TODAY_ICON[item.kind]}
                        iconColor={item.overdue ? colors.danger : hubColors.operations.fg}
                        iconBackground={item.overdue ? colors.dangerSoft : hubColors.operations.bg}
                        title={item.title}
                        subtitle={[item.when, item.subtitle].filter(Boolean).join(' · ') || undefined}
                        onPress={item.recordKey ? () => open(item.recordKey) : undefined}
                        chevron={item.recordKey ? undefined : false}
                        divider={i < data.today.length - 1}
                      />
                    ))
                  )}
                </Card>
              ) : null}
            </FadeInUp>

            <FadeInUp index={1}>
              <Box
                count={data.counts.prospects}
                label="Prospects to call"
                icon="call"
                tint={hubColors.crm}
                onPress={() => router.navigate({ pathname: '/workspace', params: { lens: 'prospect' } } as never)}
              />
            </FadeInUp>

            {role?.isSalesManager ? (
              <FadeInUp index={1}>
                <Box
                  count={data.unassigned}
                  label="Unassigned leads"
                  icon="people"
                  tint={{ fg: colors.amberDeep, bg: colors.amberSoft }}
                  onPress={() => router.navigate({ pathname: '/workspace', params: { lens: 'unassigned' } } as never)}
                />
              </FadeInUp>
            ) : null}

            <FadeInUp index={1}>
              <Box
                count={
                  data.counts.prospects + data.counts.contacted + data.counts.interested + data.counts.booked + data.counts.customers
                }
                label="On your lead map"
                icon="map"
                tint={hubColors.operations}
                onPress={() => router.push('/lead-map' as never)}
              />
            </FadeInUp>

            {messages > 0 ? (
              <FadeInUp index={2}>
                <Box
                  count={messages}
                  label={messages === 1 ? 'New message' : 'New messages'}
                  icon="chatbubbles"
                  tint={{ fg: colors.danger, bg: colors.dangerSoft }}
                  open={openBox === 'messages'}
                  onPress={() => toggle('messages')}
                />
                {openBox === 'messages' ? (
                  <Card padded={false} style={styles.drawer}>
                    {data.missed.map((m, i) => (
                      <ListRow
                        key={`missed:${m.id}`}
                        icon="call"
                        iconColor={colors.danger}
                        iconBackground={colors.dangerSoft}
                        title={`Missed call · ${m.name}${m.count > 1 ? ` (${m.count})` : ''}`}
                        subtitle={whenLabel(m.at)}
                        right={
                          m.phone ? (
                            <Button
                              label="Call back"
                              size="sm"
                              variant="secondary"
                              onPress={() => callBack(m.phone as string, m.name)}
                            />
                          ) : undefined
                        }
                        chevron={false}
                        onPress={m.recordKey ? () => open(m.recordKey) : undefined}
                        divider={i < messages - 1}
                      />
                    ))}
                    {data.unread.map((r, i) => (
                      <ListRow
                        key={`unread:${r.key}`}
                        icon="chatbubble"
                        iconColor={hubColors.crm.fg}
                        iconBackground={hubColors.crm.bg}
                        title={r.name}
                        subtitle={r.unread === 1 ? 'New text' : `${r.unread} new texts`}
                        badge={r.unread}
                        onPress={() => open(r.key)}
                        divider={data.missed.length + i < messages - 1}
                      />
                    ))}
                  </Card>
                ) : null}
                {callNotice ? (
                  <AppText variant="caption" color={colors.danger} style={styles.notice}>
                    {callNotice}
                  </AppText>
                ) : null}
              </FadeInUp>
            ) : null}

            <FadeInUp index={3}>
              <Box
                count={formatCents(data.commissionCents) || '$0'}
                label="Commission this pay period"
                icon="cash"
                tint={{ fg: colors.mintDeep, bg: colors.mintSoft }}
                onPress={() => router.push('/commission' as never)}
              />
            </FadeInUp>

            <FadeInUp index={4}>
              <Button
                label="New prospect"
                icon="person-add"
                fullWidth
                style={styles.newProspect}
                onPress={() => router.navigate({ pathname: '/workspace', params: { new: 'prospect' } } as never)}
              />
            </FadeInUp>
          </>
        )}
      </View>
    </Screen>
  );
}

const TODAY_ICON: Record<TodayItem['kind'], 'construct' | 'calendar' | 'checkbox'> = {
  visit: 'construct',
  appointment: 'calendar',
  task: 'checkbox',
};

/** One big tappable box: the number, what it counts, a chevron. */
function Box({
  count,
  label,
  icon,
  tint,
  open,
  onPress,
}: {
  count: number | string;
  label: string;
  icon: keyof typeof Ionicons.glyphMap;
  tint: { fg: string; bg: string };
  /** Set for a box that opens in place; undefined for one that navigates. */
  open?: boolean;
  onPress: () => void;
}) {
  return (
    <AnimatedPressable onPress={onPress} accessibilityRole="button" accessibilityLabel={`${label}: ${count}`}>
      <Card style={[styles.box, { borderColor: tint.fg }]}>
        <View style={[styles.boxIcon, { backgroundColor: tint.bg }]}>
          <Ionicons name={icon} size={20} color={tint.fg} />
        </View>
        <AppText variant="title" color={tint.fg} style={styles.boxCount}>
          {count}
        </AppText>
        <AppText variant="heading" color={colors.textPrimary} style={styles.boxLabel} numberOfLines={1}>
          {label}
        </AppText>
        <Ionicons
          name={open === undefined ? 'chevron-forward' : open ? 'chevron-up' : 'chevron-down'}
          size={18}
          color={colors.textMuted}
        />
      </Card>
    </AnimatedPressable>
  );
}

/** "2:14 PM" today, "Yesterday 2:14 PM", or "Mon 2:14 PM". */
function whenLabel(iso: string): string {
  const d = new Date(iso);
  const time = d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  const today = new Date();
  const startOfToday = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime();
  if (d.getTime() >= startOfToday) return time;
  if (d.getTime() >= startOfToday - 86_400_000) return `Yesterday ${time}`;
  return `${d.toLocaleDateString('en-US', { weekday: 'short' })} ${time}`;
}

const styles = StyleSheet.create({
  scroll: { paddingBottom: spacing.xl },
  body: {
    width: '100%',
    maxWidth: 560,
    alignSelf: 'center',
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.md,
    gap: spacing.md,
  },
  loading: { marginVertical: spacing.xl },
  box: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    borderWidth: 1.5,
    borderRadius: radii.md,
    paddingVertical: spacing.lg,
  },
  boxIcon: { width: 40, height: 40, borderRadius: radii.sm, alignItems: 'center', justifyContent: 'center' },
  boxCount: { minWidth: 34 },
  boxLabel: { flex: 1 },
  drawer: { marginTop: spacing.xs },
  empty: { padding: spacing.md },
  notice: { marginTop: spacing.xs },
  newProspect: { marginTop: spacing.sm },
});
