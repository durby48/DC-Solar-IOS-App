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
  groupStorms,
  inPath,
  loadAllReports,
  loadWarnings,
  STORM_WINDOWS,
  ZONE_LEGEND,
  type MapStorm,
  type StormKind,
  type StormLayers,
  type StormReportPoint,
  type StormWarning,
  type StormWindow,
} from '@/lib/stormLayers';
import { hailLabel, stormDayLabel } from '@/lib/storms';

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

  // Storms (2026-10-09, reworked): OFF until turned on; then a list of storms
  // in two categories (Hail / Wind), the most recent one that hit someone
  // picked; or an overview of a time window. Radar and NWS warnings are
  // separate live-weather switches.
  const [stormsOn, setStormsOn] = useState(Boolean(stormDay));
  const [stormKind, setStormKind] = useState<StormKind>('hail');
  /** A storm key (`hail:YYYY-MM-DD`) or an overview window. */
  const [stormPick, setStormPick] = useState<string | null>(stormDay ? `hail:${stormDay}` : null);
  const [radar, setRadar] = useState(false);
  const [warningsOn, setWarningsOn] = useState(false);
  const [labels, setLabels] = useState(true);
  const [warnings, setWarnings] = useState<StormWarning[]>([]);
  const [allReports, setAllReports] = useState<StormReportPoint[] | null>(null);
  useEffect(() => {
    if (!stormsOn || !warningsOn) return;
    let cancelled = false;
    void loadWarnings().then((w) => !cancelled && setWarnings(w));
    return () => {
      cancelled = true;
    };
  }, [stormsOn, warningsOn]);
  useEffect(() => {
    if (!stormsOn || allReports) return;
    let cancelled = false;
    void loadAllReports().then((r) => !cancelled && setAllReports(r));
    return () => {
      cancelled = true;
    };
  }, [stormsOn, allReports]);
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

  // Storms from the reports, with who (of the pins shown) is in each path.
  const stormList = useMemo<MapStorm[]>(() => (allReports ? groupStorms(allReports, shown) : []), [allReports, shown]);
  const listed = useMemo(
    () => stormList.filter((st) => st.kind === stormKind && st.affected.length > 0),
    [stormList, stormKind],
  );
  // Most recent storm that hit someone, once the list is known.
  useEffect(() => {
    if (!stormsOn || stormPick || listed.length === 0) return;
    setStormPick(listed[0].key);
  }, [stormsOn, stormPick, listed]);
  const pickedStorm = stormPick && !stormPick.startsWith('window:') ? (stormList.find((st) => st.key === stormPick) ?? null) : null;
  const pickedWindow = stormPick?.startsWith('window:') ? (stormPick.slice(7) as StormWindow) : null;
  const windowReports = useMemo(() => {
    if (!pickedWindow || !allReports) return [];
    const days = STORM_WINDOWS.find((w) => w.key === pickedWindow)?.days ?? 30;
    const cutoff = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
    return allReports.filter((r) => r.kind === stormKind && r.day >= cutoff && (r.kind === 'wind' || (r.size ?? 0) >= 1));
  }, [pickedWindow, allReports, stormKind]);
  const stormReports = pickedStorm ? pickedStorm.reports : windowReports;
  const highlight = useMemo(() => {
    if (!stormsOn || stormReports.length === 0) return null;
    return new Set(pickedStorm ? pickedStorm.affected : inPath(shown, windowReports));
  }, [stormsOn, stormReports, pickedStorm, shown, windowReports]);
  const storms = useMemo<StormLayers | null>(() => {
    if (!stormsOn) return null;
    return {
      radar,
      warnings: warningsOn ? warnings : [],
      reports: stormReports,
      highlight,
      fitKey: stormPick,
    };
  }, [stormsOn, radar, warningsOn, warnings, stormReports, highlight, stormPick]);
  const hitLeads = highlight ? shown.filter((p) => highlight.has(p.key) && p.stage !== 'customer').length : 0;
  const hitCustomers = highlight ? shown.filter((p) => highlight.has(p.key) && p.stage === 'customer').length : 0;

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
            onPress={() => setLabels((v) => !v)}
            style={[styles.stormsButton, styles.labelsButton, labels && styles.labelsButtonOn]}
            accessibilityRole="switch"
            accessibilityState={{ checked: labels }}>
            <Text style={[styles.stormsButtonText, labels && styles.stormsButtonTextOn]}>Labels</Text>
          </Pressable>
          <Pressable
            onPress={() => {
              setStormsOn((v) => !v);
              if (stormsOn) setStormPick(null);
            }}
            style={[styles.stormsButton, stormsOn && styles.stormsButtonOn]}
            accessibilityRole="switch"
            accessibilityState={{ checked: stormsOn }}>
            <Text style={[styles.stormsButtonText, stormsOn && styles.stormsButtonTextOn]}>⛈ Storms</Text>
          </Pressable>
        </View>
        {stormsOn ? (
          <>
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chipRow}>
              {(['hail', 'wind'] as StormKind[]).map((k) => (
                <Pressable
                  key={k}
                  onPress={() => {
                    setStormKind(k);
                    setStormPick(null);
                  }}
                  style={[styles.kindChip, stormKind === k && styles.kindChipOn]}>
                  <Text style={[styles.kindChipText, stormKind === k && styles.kindChipTextOn]}>
                    {k === 'hail' ? 'Hail' : 'Wind'}
                  </Text>
                </Pressable>
              ))}
              {[
                { label: 'Radar', on: radar, set: setRadar },
                { label: 'Warnings', on: warningsOn, set: setWarningsOn },
              ].map((t) => (
                <Pressable key={t.label} onPress={() => t.set(!t.on)} style={[styles.chip, !t.on && styles.chipOff]}>
                  <Text style={[styles.chipText, !t.on && styles.chipTextOff]}>{t.label}</Text>
                </Pressable>
              ))}
            </ScrollView>
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chipRow}>
              {allReports === null ? (
                <Text style={styles.summary}>Loading storms…</Text>
              ) : listed.length === 0 ? (
                <Text style={styles.summary}>No {stormKind} storms hit these pins in the last 2 years.</Text>
              ) : (
                listed.slice(0, 40).map((st) => {
                  const on = stormPick === st.key;
                  return (
                    <Pressable key={st.key} onPress={() => setStormPick(st.key)} style={[styles.stormChip, on && styles.stormChipOn]}>
                      <Text style={[styles.stormChipTitle, on && styles.stormChipTextOn]}>
                        {stormDayLabel(st.day, false)}
                        {st.kind === 'hail' ? ` · ${hailLabel(st.maxSize)}` : st.maxSize ? ` · ${st.maxSize} mph` : ''}
                      </Text>
                      <Text style={[styles.stormChipSub, on && styles.stormChipTextOn]} numberOfLines={1}>
                        {st.affected.length} in path{st.place ? ` · ${st.place}` : ''}
                      </Text>
                    </Pressable>
                  );
                })
              )}
            </ScrollView>
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chipRow}>
              <Text style={styles.overviewLabel}>All storms:</Text>
              {STORM_WINDOWS.map((w) => {
                const on = stormPick === `window:${w.key}`;
                return (
                  <Pressable key={w.key} onPress={() => setStormPick(`window:${w.key}`)} style={[styles.repChip, on && styles.repChipOn]}>
                    <Text style={[styles.repChipText, on && styles.repChipTextOn]}>{w.label}</Text>
                  </Pressable>
                );
              })}
            </ScrollView>
          </>
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
            labels={labels}
          />
        )}
      </View>

      {stormsOn && stormReports.length > 0 && !selected ? (
        <Card style={styles.card}>
          <View style={styles.legendRow}>
            {stormKind === 'hail' ? (
              ZONE_LEGEND.map((l) => (
                <View key={l.label} style={styles.legendItem}>
                  <View style={[styles.legendSwatch, { backgroundColor: l.color }]} />
                  <Text style={styles.legendText}>{l.label}</Text>
                </View>
              ))
            ) : (
              <View style={styles.legendItem}>
                <View style={[styles.legendSwatch, { backgroundColor: '#FF8C1A' }]} />
                <Text style={styles.legendText}>Damaging wind</Text>
              </View>
            )}
            <Text style={styles.legendText}>· shaded = within 3 mi</Text>
          </View>
          <AppText variant="bodyStrong">
            {pickedStorm
              ? `${stormDayLabel(pickedStorm.day, false)} ${pickedStorm.kind}`
              : `All ${stormKind} storms · ${STORM_WINDOWS.find((w) => w.key === pickedWindow)?.label ?? ''}`}
            {' · '}
            {hitLeads} lead{hitLeads === 1 ? '' : 's'} · {hitCustomers} customer{hitCustomers === 1 ? '' : 's'} in the path
          </AppText>
          {pickedStorm && pickedStorm.kind === 'hail' ? (
            <View style={styles.cardButtons}>
              <Button
                label="Open Storm report"
                icon="thunderstorm-outline"
                size="sm"
                onPress={() => router.push({ pathname: '/storm-reports/[day]', params: { day: pickedStorm.day } } as never)}
              />
              {isAdmin ? (
                <Button
                  label="Assign these leads"
                  icon="people-outline"
                  size="sm"
                  variant="secondary"
                  onPress={() => router.push({ pathname: '/assign-leads', params: { storm: pickedStorm.day } } as never)}
                />
              ) : null}
            </View>
          ) : null}
        </Card>
      ) : null}

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
  labelsButton: { marginRight: spacing.xs },
  labelsButtonOn: { backgroundColor: colors.olive },
  kindChip: { paddingHorizontal: spacing.md, paddingVertical: 5, borderRadius: radii.pill, backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.line },
  kindChipOn: { backgroundColor: colors.ocean, borderColor: colors.ocean },
  kindChipText: { color: colors.ink, fontSize: 12, fontWeight: '800' },
  kindChipTextOn: { color: colors.textInverse },
  stormChip: { paddingHorizontal: spacing.sm + 2, paddingVertical: 6, borderRadius: radii.md, backgroundColor: colors.surface, minWidth: 120, maxWidth: 220 },
  stormChipOn: { backgroundColor: colors.ocean },
  stormChipTitle: { color: colors.ink, fontSize: 12, fontWeight: '800' },
  stormChipSub: { color: colors.inkSoft, fontSize: 11, fontWeight: '600' },
  stormChipTextOn: { color: colors.textInverse },
  overviewLabel: { color: colors.inkSoft, fontSize: 12, fontWeight: '700', alignSelf: 'center' },
  legendRow: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: spacing.sm },
  legendItem: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  legendSwatch: { width: 12, height: 12, borderRadius: 6, opacity: 0.85 },
  legendText: { color: colors.inkSoft, fontSize: 11, fontWeight: '700' },
  mapWrap: { flex: 1, padding: spacing.md },
  loading: { marginTop: spacing.xl },
  card: { marginHorizontal: spacing.md, marginBottom: spacing.md, gap: spacing.sm },
  cardHead: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  cardButtons: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  flex: { flex: 1 },
});
