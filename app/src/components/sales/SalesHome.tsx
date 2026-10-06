import Ionicons from '@expo/vector-icons/Ionicons';
import { useFocusEffect, useRouter } from 'expo-router';
import { useCallback, useRef, useState } from 'react';
import { ActivityIndicator, StyleSheet, TextInput, View, useWindowDimensions } from 'react-native';

import {
  AnimatedPressable,
  AppText,
  Button,
  Card,
  FadeInUp,
  ListRow,
  SectionHeader,
  StatTile,
} from '@/components/ui';
import { colors, hubColors, radii, spacing } from '@/constants/theme';
import { formatPhone, saveMyCellPhone, useCommsRealtime } from '@/lib/comms';
import { type WorkspaceRecord } from '@/lib/crmWorkspace';
import { useRole } from '@/lib/role';
import { fetchSalesHome, type SalesHomeData, type TodayItem } from '@/lib/salesHome';
import { inAppCallingSupported } from '@/lib/voice';

/**
 * The Sales Home (2026-10-06, S1): a rep's day at a glance, between the
 * greeting header and the shared Account section of `(tabs)/index.tsx`.
 *
 *   Your number      · their DC Solar line, and their cell (the fallback when
 *                      they miss a call in the app) — editable right here
 *   Needs attention  · missed calls (last 3 days, not yet called back) and
 *                      unread texts; hidden when there are none
 *   Today            · their booked visits, appointments, and tasks due today
 *                      or overdue
 *   Call next        · newest prospects nobody has contacted, with Call
 *   My pipeline      · counts per step, each opening that CRM lens
 *   + New prospect
 *
 * No money anywhere except (from S4) their own commission. Every tap lands in
 * the CRM tab via its deep links (`/workspace?open=…`, `?lens=…`,
 * `?new=prospect`) or on the call screen.
 */
export function SalesHome() {
  const router = useRouter();
  const role = useRole();
  const { width } = useWindowDimensions();
  const [data, setData] = useState<SalesHomeData | null>(null);
  const [callNotice, setCallNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    const next = await fetchSalesHome(role?.email ?? null);
    setData(next);
  }, [role?.email]);

  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );

  // A text or call arriving while Home is open: one trailing reload per burst
  // (a single text fires several row updates as it is delivered).
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
  const lens = (name: string) => router.navigate({ pathname: '/workspace', params: { lens: name } } as never);

  const call = (phone: string | null, name: string) => {
    if (!phone) return;
    if (!inAppCallingSupported()) {
      // Never the phone's own dialer: that would show the customer the rep's
      // PERSONAL number (same rule as the CRM's Call button).
      setCallNotice('Calls from your DC Solar number work in the DC Solar app or at app.dcsolarkc.com.');
      return;
    }
    router.push({ pathname: '/call', params: { to: phone, name } } as never);
  };

  if (!data) {
    return (
      <View style={styles.loading}>
        <ActivityIndicator color={hubColors.crm.fg} />
      </View>
    );
  }

  const attention = data.missed.length + data.unread.length;
  const statColumns = width >= 700 ? 5 : 2;

  return (
    <View style={styles.wrap}>
      <FadeInUp index={0}>
        <LineCard line={data.line} cell={data.cell} onSaved={() => void load()} />
      </FadeInUp>

      {attention > 0 ? (
        <FadeInUp index={1}>
          <SectionHeader title="Needs attention" accent={colors.danger} />
          <Card padded={false}>
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
                    <Button label="Call back" size="sm" variant="secondary" onPress={() => call(m.phone, m.name)} />
                  ) : undefined
                }
                chevron={false}
                onPress={m.recordKey ? () => open(m.recordKey) : undefined}
                divider={i < attention - 1}
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
                divider={data.missed.length + i < attention - 1}
              />
            ))}
          </Card>
        </FadeInUp>
      ) : null}

      <FadeInUp index={2}>
        <SectionHeader title="Today" accent={hubColors.operations.fg} />
        <Card padded={false}>
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
      </FadeInUp>

      <FadeInUp index={3}>
        <SectionHeader
          title="Call next"
          subtitle="Your newest prospects"
          accent={hubColors.crm.fg}
          action={data.counts.prospects > data.callNext.length ? { label: 'All prospects', onPress: () => lens('prospect') } : undefined}
        />
        <Card padded={false}>
          {data.callNext.length === 0 ? (
            <AppText variant="body" color={colors.textSecondary} style={styles.empty}>
              No new prospects. You&apos;re caught up.
            </AppText>
          ) : (
            data.callNext.map((r, i) => (
              <ListRow
                key={r.key}
                icon="person"
                iconColor={hubColors.crm.fg}
                iconBackground={hubColors.crm.bg}
                title={r.name}
                subtitle={prospectSubtitle(r)}
                right={
                  r.phoneE164 ? (
                    <Button label="Call" icon="call" size="sm" onPress={() => call(r.phoneE164, r.name)} />
                  ) : undefined
                }
                chevron={false}
                onPress={() => open(r.key)}
                divider={i < data.callNext.length - 1}
              />
            ))
          )}
        </Card>
        {callNotice ? (
          <AppText variant="caption" color={colors.danger} style={styles.notice}>
            {callNotice}
          </AppText>
        ) : null}
      </FadeInUp>

      <FadeInUp index={4}>
        <SectionHeader title="My pipeline" accent={hubColors.crm.fg} />
        <View style={styles.stats}>
          {(
            [
              ['Prospects', data.counts.prospects, 'prospect', 0],
              ['Contacted', data.counts.contacted, 'working', 1],
              ['Interested', data.counts.interested, 'working', 2],
              ['Visits booked', data.counts.booked, 'working', 5],
              ['Customers', data.counts.customers, 'customer', 6],
            ] as const
          ).map(([label, value, target, tone]) => (
            <View key={label} style={[styles.statCell, { width: `${100 / statColumns}%` }]}>
              <AnimatedPressable onPress={() => lens(target)} accessibilityRole="button" accessibilityLabel={`${label}: ${value}`}>
                <StatTile label={label} value={value} tone={tone} compact edge />
              </AnimatedPressable>
            </View>
          ))}
        </View>
      </FadeInUp>

      <FadeInUp index={5}>
        <Button
          label="New prospect"
          icon="person-add"
          fullWidth
          onPress={() => router.navigate({ pathname: '/workspace', params: { new: 'prospect' } } as never)}
        />
      </FadeInUp>
    </View>
  );
}

const TODAY_ICON: Record<TodayItem['kind'], 'construct' | 'calendar' | 'checkbox'> = {
  visit: 'construct',
  appointment: 'calendar',
  task: 'checkbox',
};

function prospectSubtitle(r: WorkspaceRecord): string {
  const bits = [r.phone ? formatPhone(r.phoneE164 ?? r.phone) : 'No phone', r.lead?.source ?? null];
  return bits.filter(Boolean).join(' · ');
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

/**
 * Their DC Solar number, and their cell. The cell is where an incoming call
 * goes when they do not answer in the app (twilio-voice-inbound), so it is
 * edited here rather than buried in a settings screen.
 */
function LineCard({ line, cell, onSaved }: { line: string | null; cell: string | null; onSaved: () => void }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(cell ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async () => {
    setBusy(true);
    setError(null);
    const result = await saveMyCellPhone(draft);
    setBusy(false);
    if (!result.ok) {
      setError(result.message);
      return;
    }
    setEditing(false);
    onSaved();
  };

  return (
    <Card style={styles.lineCard}>
      <View style={styles.lineRow}>
        <View style={styles.lineIcon}>
          <Ionicons name="call" size={18} color={hubColors.crm.fg} />
        </View>
        <View style={styles.lineBody}>
          <AppText variant="caption" color={colors.textSecondary}>
            Your DC Solar number
          </AppText>
          <AppText variant="heading" color={line ? colors.textPrimary : colors.textSecondary}>
            {line ? formatPhone(line) : 'Not assigned yet — ask an admin'}
          </AppText>
        </View>
      </View>
      {editing ? (
        <View style={styles.cellEdit}>
          <TextInput
            value={draft}
            onChangeText={setDraft}
            placeholder="Your cell, e.g. 816 555 0123"
            placeholderTextColor={colors.textMuted}
            keyboardType="phone-pad"
            style={styles.input}
          />
          <View style={styles.cellButtons}>
            <Button label="Cancel" variant="ghost" size="sm" onPress={() => setEditing(false)} />
            <Button label="Save" size="sm" loading={busy} onPress={() => void save()} />
          </View>
          {error ? (
            <AppText variant="caption" color={colors.danger}>
              {error}
            </AppText>
          ) : null}
        </View>
      ) : (
        <AnimatedPressable
          onPress={() => {
            setDraft(cell ?? '');
            setEditing(true);
          }}
          accessibilityRole="button"
          style={styles.cellRow}>
          <AppText variant="caption" color={colors.textSecondary} style={styles.cellText}>
            {cell
              ? `Missed calls ring your cell: ${formatPhone(cell)}`
              : 'Add your cell so calls you miss in the app still reach you'}
          </AppText>
          <AppText variant="caption" color={colors.accentLink}>
            {cell ? 'Change' : 'Add'}
          </AppText>
        </AnimatedPressable>
      )}
    </Card>
  );
}

const styles = StyleSheet.create({
  wrap: { gap: spacing.md },
  loading: { paddingVertical: spacing.xl, alignItems: 'center' },
  empty: { padding: spacing.md },
  notice: { marginTop: spacing.xs },
  stats: { flexDirection: 'row', flexWrap: 'wrap', marginHorizontal: -spacing.xs },
  statCell: { paddingHorizontal: spacing.xs, paddingBottom: spacing.sm },
  lineCard: { gap: spacing.sm, marginTop: spacing.xs },
  lineRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  lineIcon: {
    width: 38,
    height: 38,
    borderRadius: radii.sm,
    backgroundColor: hubColors.crm.bg,
    alignItems: 'center',
    justifyContent: 'center',
  },
  lineBody: { flex: 1, gap: 2 },
  cellRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  cellText: { flex: 1 },
  cellEdit: { gap: spacing.xs },
  cellButtons: { flexDirection: 'row', justifyContent: 'flex-end', gap: spacing.sm },
  input: {
    backgroundColor: colors.surfaceSunk,
    borderRadius: radii.sm,
    borderWidth: 1,
    borderColor: colors.border,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm + 2,
    color: colors.textPrimary,
    fontSize: 15,
  },
});
