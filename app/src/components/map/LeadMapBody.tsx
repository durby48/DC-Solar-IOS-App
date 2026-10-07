import { useFocusEffect, useRouter } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Platform, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { LeadMapView, NATIVE_MAP } from '@/components/map/LeadMapView';
import { AppText, Button, Card } from '@/components/ui';
import { colors, hubColors, radii, spacing } from '@/constants/theme';
import {
  fetchMapPoints,
  placeNewAddresses,
  STAGE_COLOR,
  STAGE_LABEL,
  STAGE_ORDER,
  type MapPoint,
  type MapStage,
} from '@/lib/leadMap';
import { fetchEmployeeOptions } from '@/lib/myhours';
import { fetchSalesTeam } from '@/lib/sales';
import { useRoleGate } from '@/lib/role';
import { firstName } from '@/lib/staffNames';
import {
  loadReportsForDay,
  loadReportsWindow,
  loadWarnings,
  STORM_WINDOWS,
  type StormLayers,
  type StormReportPoint,
  type StormWarning,
  type StormWindow,
} from '@/lib/stormLayers';
import { stormDayLabel } from '@/lib/storms';

/**
 * The Lead map's body (2026-10-07; a component since 2026-10-09 so the
 * `/lead-map` screen and the sales Lead map TAB share it). `focusKey` (a
 * record key, from the map in a lead's / customer's panel) starts the map
 * zoomed in on that pin, on Satellite, with its card open — every other pin
 * still shows.
 *
 * Every lead and customer the caller can see in the CRM, pinned by address
 * and coloured by stage (Prospect · Contacted · Interested · Visit booked ·
 * Customer); chips switch stages off and on, and admins can narrow to one
 * rep or the Unassigned pool. Map / Satellite switch on the map; tap a pin
 * for its card → Open in CRM, or See the roof (satellite, zoomed in).
 *
 * Opening the map also places any new or edited addresses (geocode-addresses)
 * and reloads if it placed some. On the phone the map itself waits for the
 * next native build (components/map/LeadMapView.tsx).
 */
export function LeadMapBody({
  focusKey = null,
  topGutter = 0,
  stormDay = null,
}: {
  focusKey?: string | null;
  topGutter?: number;
  /** Opened from a Storm report: Storms on, that day's reports, zoomed to them. */
  stormDay?: string | null;
}) {
  const router = useRouter();
  const gate = useRoleGate();
  const isSales = gate.role?.isSales === true;
  // Admins and sales managers see the whole team, and filter by rep.
  const isAdmin = gate.role?.isAdmin === true || gate.role?.isSalesManager === true;
  const [points, setPoints] = useState<MapPoint[] | null>(null);
  const [unplaced, setUnplaced] = useState(0);
  const [hidden, setHidden] = useState<Set<MapStage>>(new Set());
  const [rep, setRep] = useState<string | null>(null); // email, 'unassigned', or null = everyone
  const [reps, setReps] = useState<{ email: string; name: string }[]>([]);
  const [selectedKey, setSelectedKey] = useState<string | null>(focusKey);
  const [roof, setRoof] = useState<{ key: string; n: number } | null>(null);
  const placing = useRef(false);

  // Storms (2026-10-09): radar, NWS warnings, NOAA hail / wind reports.
  const [stormsOn, setStormsOn] = useState(Boolean(stormDay));
  const [radar, setRadar] = useState(!stormDay);
  const [warningsOn, setWarningsOn] = useState(!stormDay);
  const [reportsOn, setReportsOn] = useState(true);
  const [stormWindow, setStormWindow] = useState<StormWindow | 'day'>(stormDay ? 'day' : '30d');
  const [warnings, setWarnings] = useState<StormWarning[]>([]);
  const [reports, setReports] = useState<StormReportPoint[]>([]);
  useEffect(() => {
    if (!stormsOn || !warningsOn) return;
    let cancelled = false;
    void loadWarnings().then((w) => !cancelled && setWarnings(w));
    return () => {
      cancelled = true;
    };
  }, [stormsOn, warningsOn]);
  useEffect(() => {
    if (!stormsOn || !reportsOn) return;
    let cancelled = false;
    const job =
      stormWindow === 'day' && stormDay
        ? loadReportsForDay(stormDay)
        : loadReportsWindow(STORM_WINDOWS.find((w) => w.key === stormWindow)?.days ?? 30);
    void job.then((r) => !cancelled && setReports(r));
    return () => {
      cancelled = true;
    };
  }, [stormsOn, reportsOn, stormWindow, stormDay]);
  const storms = useMemo<StormLayers | null>(() => {
    if (!stormsOn) return null;
    const shownReports = reportsOn ? reports : [];
    return {
      radar,
      warnings: warningsOn ? warnings : [],
      reports: shownReports,
      fitTo: stormWindow === 'day' ? shownReports.filter((r) => r.kind === 'hail') : undefined,
    };
  }, [stormsOn, radar, warningsOn, warnings, reportsOn, reports, stormWindow]);

  const load = useCallback(async () => {
    const result = await fetchMapPoints(isSales);
    setPoints(result.points);
    setUnplaced(result.unplaced);
  }, [isSales]);

  useFocusEffect(
    useCallback(() => {
      if (gate.phase !== 'ready') return;
      void load();
      if (isAdmin) void (gate.role?.isSales ? fetchSalesTeam() : fetchEmployeeOptions()).then(setReps);
      if (!placing.current) {
        placing.current = true;
        void placeNewAddresses().then((placed) => {
          placing.current = false;
          if (placed > 0) void load();
        });
      }
    }, [gate.phase, load, isAdmin, gate.role?.isSales]),
  );

  const shown = useMemo(
    () =>
      (points ?? []).filter(
        (p) =>
          !hidden.has(p.stage) &&
          (rep === null ||
            (rep === 'unassigned' ? p.stage !== 'customer' && !p.assignedTo : p.assignedTo?.toLowerCase() === rep)),
      ),
    [points, hidden, rep],
  );
  const counts = useMemo(() => {
    const c: Record<MapStage, number> = { prospect: 0, contacted: 0, interested: 0, booked: 0, customer: 0 };
    for (const p of points ?? []) c[p.stage] += 1;
    return c;
  }, [points]);
  const selected = shown.find((p) => p.key === selectedKey) ?? null;

  const toggle = (s: MapStage) =>
    setHidden((prev) => {
      const next = new Set(prev);
      if (next.has(s)) next.delete(s);
      else next.add(s);
      return next;
    });

  return (
    <SafeAreaView edges={[]} style={styles.screen}>
      <View style={[styles.filters, topGutter ? { paddingRight: topGutter } : null]}>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chipRow}>
          {STAGE_ORDER.map((s) => (
            <Pressable
              key={s}
              onPress={() => toggle(s)}
              style={[styles.chip, hidden.has(s) && styles.chipOff]}
              accessibilityRole="switch"
              accessibilityState={{ checked: !hidden.has(s) }}>
              <View style={[styles.dot, { backgroundColor: STAGE_COLOR[s] }]} />
              <Text style={[styles.chipText, hidden.has(s) && styles.chipTextOff]}>
                {STAGE_LABEL[s]} {counts[s]}
              </Text>
            </Pressable>
          ))}
        </ScrollView>
        {isAdmin ? (
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chipRow}>
            {[{ email: '', name: 'Everyone' }, { email: 'unassigned', name: 'Unassigned' }, ...reps].map((r) => {
              const value = r.email === '' ? null : r.email.toLowerCase();
              const on = rep === value;
              return (
                <Pressable key={r.email || 'all'} onPress={() => setRep(value)} style={[styles.repChip, on && styles.repChipOn]}>
                  <Text style={[styles.repChipText, on && styles.repChipTextOn]}>{firstName(r.name)}</Text>
                </Pressable>
              );
            })}
          </ScrollView>
        ) : null}
        <View style={styles.summaryRow}>
          <Text style={[styles.summary, styles.flex]}>
            {points === null ? 'Loading…' : `${shown.length} on the map`}
            {unplaced > 0 ? ` · ${unplaced} address${unplaced === 1 ? '' : 'es'} could not be placed` : ''}
          </Text>
          <Pressable
            onPress={() => setStormsOn((v) => !v)}
            style={[styles.stormsButton, stormsOn && styles.stormsButtonOn]}
            accessibilityRole="switch"
            accessibilityState={{ checked: stormsOn }}>
            <Text style={[styles.stormsButtonText, stormsOn && styles.stormsButtonTextOn]}>⛈ Storms</Text>
          </Pressable>
        </View>
        {stormsOn ? (
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chipRow}>
            {[
              { label: 'Radar', on: radar, set: setRadar },
              { label: 'Warnings', on: warningsOn, set: setWarningsOn },
              { label: 'Hail & wind', on: reportsOn, set: setReportsOn },
            ].map((t) => (
              <Pressable key={t.label} onPress={() => t.set(!t.on)} style={[styles.chip, !t.on && styles.chipOff]}>
                <Text style={[styles.chipText, !t.on && styles.chipTextOff]}>{t.label}</Text>
              </Pressable>
            ))}
            {stormDay ? (
              <Pressable onPress={() => setStormWindow('day')} style={[styles.repChip, stormWindow === 'day' && styles.repChipOn]}>
                <Text style={[styles.repChipText, stormWindow === 'day' && styles.repChipTextOn]}>{stormDayLabel(stormDay, false)} storm</Text>
              </Pressable>
            ) : null}
            {STORM_WINDOWS.map((w) => (
              <Pressable key={w.key} onPress={() => setStormWindow(w.key)} style={[styles.repChip, stormWindow === w.key && styles.repChipOn]}>
                <Text style={[styles.repChipText, stormWindow === w.key && styles.repChipTextOn]}>{w.label}</Text>
              </Pressable>
            ))}
          </ScrollView>
        ) : null}
      </View>

      <View style={styles.mapWrap}>
        {points === null ? (
          <ActivityIndicator color={hubColors.crm.fg} style={styles.loading} />
        ) : (
          <LeadMapView
            points={shown}
            selectedKey={selectedKey}
            onSelect={setSelectedKey}
            roof={roof}
            focusKey={focusKey}
            storms={storms}
          />
        )}
      </View>

      {selected ? (
        <Card style={styles.card}>
          <View style={styles.cardHead}>
            <View style={[styles.dot, styles.dotBig, { backgroundColor: STAGE_COLOR[selected.stage] }]} />
            <View style={styles.flex}>
              <AppText variant="bodyStrong" numberOfLines={1}>
                {selected.name}
              </AppText>
              <AppText variant="caption" color={colors.textSecondary} numberOfLines={2}>
                {STAGE_LABEL[selected.stage]}
                {selected.address ? ` · ${selected.address}` : ''}
                {selected.approx ? ' · approximate location' : ''}
              </AppText>
            </View>
          </View>
          <View style={styles.cardButtons}>
            <Button
              label="Open in CRM"
              icon="open-outline"
              size="sm"
              onPress={() => router.navigate({ pathname: '/workspace', params: { open: selected.key } } as never)}
            />
            {Platform.OS === 'web' || NATIVE_MAP ? (
              <Button
                label="See the roof"
                icon="earth"
                size="sm"
                variant="secondary"
                onPress={() => setRoof((r) => ({ key: selected.key, n: (r?.n ?? 0) + 1 }))}
              />
            ) : null}
          </View>
        </Card>
      ) : null}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.surfaceAlt },
  filters: { paddingTop: spacing.sm, gap: spacing.xs },
  chipRow: { gap: spacing.xs, paddingHorizontal: spacing.md },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: spacing.sm + 2,
    paddingVertical: 5,
    borderRadius: radii.pill,
    backgroundColor: colors.surface,
  },
  chipOff: { opacity: 0.45 },
  chipText: { color: colors.ink, fontSize: 12, fontWeight: '700' },
  chipTextOff: { textDecorationLine: 'line-through' },
  dot: { width: 10, height: 10, borderRadius: 5 },
  dotBig: { width: 14, height: 14, borderRadius: 7 },
  repChip: { paddingHorizontal: spacing.sm + 2, paddingVertical: 5, borderRadius: radii.pill, backgroundColor: hubColors.crm.bg },
  repChipOn: { backgroundColor: hubColors.crm.fg },
  repChipText: { color: hubColors.crm.deep, fontSize: 12, fontWeight: '700' },
  repChipTextOn: { color: colors.white },
  summary: { color: colors.inkSoft, fontSize: 12, fontWeight: '600', paddingHorizontal: spacing.md },
  summaryRow: { flexDirection: 'row', alignItems: 'center', paddingRight: spacing.md },
  stormsButton: { paddingHorizontal: spacing.sm + 2, paddingVertical: 5, borderRadius: radii.pill, backgroundColor: colors.surface },
  stormsButtonOn: { backgroundColor: colors.ocean },
  stormsButtonText: { color: colors.ink, fontSize: 12, fontWeight: '800' },
  stormsButtonTextOn: { color: colors.textInverse },
  mapWrap: { flex: 1, padding: spacing.md },
  loading: { marginTop: spacing.xl },
  card: { marginHorizontal: spacing.md, marginBottom: spacing.md, gap: spacing.sm },
  cardHead: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  cardButtons: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  flex: { flex: 1 },
});
