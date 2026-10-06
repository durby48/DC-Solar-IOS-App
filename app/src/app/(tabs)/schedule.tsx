import Ionicons from '@expo/vector-icons/Ionicons';
import { Redirect, useFocusEffect, useRouter } from 'expo-router';
import { useCallback, useMemo, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, View } from 'react-native';

import { AppText, Card, ListRow, Screen } from '@/components/ui';
import { colors, hubColors, radii, spacing } from '@/constants/theme';
import { fetchAvailability, isoDay, spotsLabel, type DayAvailability } from '@/lib/availability';
import { fetchWorkspaceRecords } from '@/lib/crmWorkspace';
import { fetchScheduleRange, type ScheduleEntry } from '@/lib/data';
import { fetchLeadAppointmentsRange, KIND_LABEL, type LeadAppointmentEntry } from '@/lib/leadAppointments';
import { useRoleGate } from '@/lib/role';
import { isServiceJob } from '@/lib/stages';
import { formatTimeLabel } from '@/lib/time';

/**
 * The Calendar tab (2026-10-06, S2) — a sales rep's week, Mon–Sat.
 *
 * Each day shows the service crew's availability as COUNTS ("3 of 5 visits
 * left", "Full", "⚠ Job not staffed" — `service_availability()`), never whose
 * job is taking the crew, and under it the rep's OWN items: the service
 * visits they booked (Paid / Not paid) and their appointments. RLS already
 * narrows both reads to the rep. Tapping an item opens that person in the CRM.
 *
 * Admins and crew have the Operations calendar; this tab is hidden from them
 * and sends them there.
 */
export default function ScheduleTab() {
  const gate = useRoleGate();
  if (gate.phase === 'ready' && !gate.role?.isSales) return <Redirect href="/calendar" />;
  return <SalesWeek />;
}

/** Monday of the week containing `d`. */
function mondayOf(d: Date): Date {
  const m = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const dow = m.getDay(); // 0 = Sunday
  m.setDate(m.getDate() - (dow === 0 ? 6 : dow - 1));
  return m;
}

interface Item {
  key: string;
  time: string | null;
  sort: string;
  title: string;
  subtitle: string | null;
  icon: 'construct' | 'calendar';
  paid?: boolean;
  recordKey: string | null;
}

function SalesWeek() {
  const router = useRouter();
  const [weekStart, setWeekStart] = useState(() => mondayOf(new Date()));
  const [avail, setAvail] = useState<Map<string, DayAvailability> | null>(null);
  const [visits, setVisits] = useState<ScheduleEntry[]>([]);
  const [appts, setAppts] = useState<LeadAppointmentEntry[]>([]);
  const [leadByJob, setLeadByJob] = useState<Map<string, string>>(new Map());

  const days = useMemo(
    () =>
      Array.from({ length: 6 }, (_, i) => {
        const d = new Date(weekStart);
        d.setDate(d.getDate() + i);
        return isoDay(d);
      }),
    [weekStart],
  );
  const from = days[0];
  const to = days[days.length - 1];

  useFocusEffect(
    useCallback(() => {
      let cancelled = false;
      setAvail(null);
      void Promise.all([
        fetchAvailability(from, to),
        fetchScheduleRange(from, to),
        fetchLeadAppointmentsRange(from, to),
        fetchWorkspaceRecords(),
      ]).then(([a, v, ap, recs]) => {
        if (cancelled) return;
        setAvail(a);
        setVisits(v.filter((e) => isServiceJob(e.job)));
        setAppts(ap.filter((x) => x.outcome !== 'canceled'));
        // A booked visit opens the lead that booked it (the rep works the
        // lead until the visit is paid), else the customer.
        const map = new Map<string, string>();
        for (const r of recs.records) if (r.lead?.converted_job_id) map.set(r.lead.converted_job_id, r.key);
        setLeadByJob(map);
      });
      return () => {
        cancelled = true;
      };
    }, [from, to]),
  );

  const itemsFor = (day: string): Item[] => {
    const list: Item[] = [
      ...visits
        .filter((v) => v.work_date === day)
        .map((v) => ({
          key: `v:${v.id}`,
          time: formatTimeLabel(v.start_time),
          sort: v.start_time ?? '99',
          title: `${v.job.job_type ?? 'Service'} · ${v.job.customer?.name ?? v.job.name}`,
          subtitle: v.job.address ?? null,
          icon: 'construct' as const,
          paid: Boolean(v.job.service_paid_at),
          recordKey: leadByJob.get(v.job.id) ?? (v.job.customer_id ? `customer:${v.job.customer_id}` : null),
        })),
      ...appts
        .filter((a) => a.appt_date === day)
        .map((a) => ({
          key: `a:${a.id}`,
          time: formatTimeLabel(a.start_time),
          sort: a.start_time ?? '99',
          title: `${KIND_LABEL[a.kind]} · ${a.lead_name}`,
          subtitle: a.lead_address,
          icon: 'calendar' as const,
          recordKey: `lead:${a.lead_id}`,
        })),
    ];
    return list.sort((x, y) => x.sort.localeCompare(y.sort));
  };

  const shiftWeek = (weeks: number) => {
    const d = new Date(weekStart);
    d.setDate(d.getDate() + weeks * 7);
    setWeekStart(d);
  };
  const today = isoDay(new Date());

  return (
    <Screen contentContainerStyle={styles.content}>
      <AppText variant="title" color={colors.textPrimary}>
        Calendar
      </AppText>
      <View style={styles.weekNav}>
        <Pressable onPress={() => shiftWeek(-1)} hitSlop={10} accessibilityLabel="Previous week" style={styles.navButton}>
          <Ionicons name="chevron-back" size={20} color={colors.textPrimary} />
        </Pressable>
        <AppText variant="heading" color={colors.textPrimary}>
          Week of {weekStart.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
        </AppText>
        <Pressable onPress={() => shiftWeek(1)} hitSlop={10} accessibilityLabel="Next week" style={styles.navButton}>
          <Ionicons name="chevron-forward" size={20} color={colors.textPrimary} />
        </Pressable>
      </View>

      {avail === null ? (
        <ActivityIndicator color={hubColors.crm.fg} style={styles.loading} />
      ) : (
        days.map((day) => {
          const a = avail.get(day);
          const items = itemsFor(day);
          const d = new Date(`${day}T12:00:00`);
          const past = day < today;
          return (
            <Card key={day} padded={false} style={[styles.day, day === today && styles.today, past && styles.past]}>
              <View style={styles.dayHead}>
                <AppText variant="bodyStrong" color={colors.textPrimary} style={styles.dayName}>
                  {d.toLocaleDateString('en-US', { weekday: 'short', month: 'numeric', day: 'numeric' })}
                </AppText>
                {a ? (
                  <View style={[styles.pill, a.spotsLeft <= 0 ? styles.pillFull : styles.pillOpen]}>
                    <AppText variant="caption" color={a.spotsLeft <= 0 ? colors.danger : colors.mintDeep}>
                      {a.spotsLeft <= 0 ? 'FULL' : spotsLabel(a)}
                    </AppText>
                  </View>
                ) : null}
              </View>
              {a && a.unstaffedJobs > 0 ? (
                <AppText variant="caption" color={colors.amberDeep} style={styles.warn}>
                  ⚠ Job not staffed yet
                </AppText>
              ) : null}
              {items.map((it, i) => (
                <ListRow
                  key={it.key}
                  icon={it.icon}
                  iconColor={it.icon === 'construct' ? hubColors.operations.fg : hubColors.crm.fg}
                  iconBackground={it.icon === 'construct' ? hubColors.operations.bg : hubColors.crm.bg}
                  title={it.title}
                  subtitle={[it.time ?? 'Any time', it.subtitle].filter(Boolean).join(' · ')}
                  right={
                    it.paid === undefined ? undefined : (
                      <AppText variant="caption" color={it.paid ? colors.mintDeep : colors.coralDeep}>
                        {it.paid ? 'Paid' : 'Not paid'}
                      </AppText>
                    )
                  }
                  onPress={
                    it.recordKey
                      ? () => router.navigate({ pathname: '/workspace', params: { open: it.recordKey } } as never)
                      : undefined
                  }
                  divider={i < items.length - 1}
                />
              ))}
            </Card>
          );
        })
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  content: { width: '100%', maxWidth: 640, alignSelf: 'center', gap: spacing.sm, paddingBottom: spacing.xl },
  weekNav: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: spacing.xs },
  navButton: { padding: spacing.xs },
  loading: { marginVertical: spacing.xl },
  day: { overflow: 'hidden' },
  today: { borderWidth: 1.5, borderColor: hubColors.crm.fg },
  past: { opacity: 0.6 },
  dayHead: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm + 2,
  },
  dayName: { flex: 1 },
  pill: { paddingHorizontal: spacing.sm, paddingVertical: 3, borderRadius: radii.pill },
  pillOpen: { backgroundColor: colors.mintSoft },
  pillFull: { backgroundColor: colors.dangerSoft },
  warn: { paddingHorizontal: spacing.md, paddingBottom: spacing.xs },
});
