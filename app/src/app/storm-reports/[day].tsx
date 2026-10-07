import Ionicons from '@expo/vector-icons/Ionicons';
import { Stack, useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Modal, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { LeadMapView } from '@/components/map/LeadMapView';
import { MapFullScreen } from '@/components/map/MapFullScreen';
import { AppText, Card, Screen, SectionHeader } from '@/components/ui';
import { colors, hubColors, radii, spacing } from '@/constants/theme';
import { sendSms } from '@/lib/comms';
import { fetchMapPoints, type MapPoint } from '@/lib/leadMap';
import { inPath, loadAllReports, MIN_HAIL, ZONE_LEGEND, type MapViewState, type StormLayers, type StormReportPoint } from '@/lib/stormLayers';
import { useRoleGate } from '@/lib/role';
import { personName } from '@/lib/staffNames';
import {
  checkStormHit,
  fetchStormHits,
  fetchStorms,
  hailLabel,
  markStormChecked,
  stormCheckText,
  stormDayLabel,
  type Storm,
  type StormHit,
} from '@/lib/storms';

/**
 * `/storm-reports/[day]` — one storm (2026-10-09): who was in its path.
 *
 *   Customers affected   distance, hail size, a "checked" tick each
 *   Leads affected       distance, hail size, owner
 *   Show on the map      the Lead map on Storms, that day
 *   Assign these leads   the sales manager / admins → Assign leads, already
 *                        narrowed to this storm's leads
 *   Text these customers a review-first text to each customer with a phone
 *   Mark storm checked   the sales manager / admins — closes the storm's
 *                        Storm check task
 *
 * A rep sees only their own leads and customers (storm_detail scopes it).
 */
export default function StormDetailScreen() {
  const { day } = useLocalSearchParams<{ day: string }>();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const gate = useRoleGate();
  const canManage = gate.role?.isAdmin === true || gate.role?.isSalesManager === true;
  const [storm, setStorm] = useState<Storm | null>(null);
  const [hits, setHits] = useState<StormHit[] | null>(null);
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [textOpen, setTextOpen] = useState(false);
  const [text, setText] = useState('');
  const [progress, setProgress] = useState<string | null>(null);
  // The storm on the map (2026-10-09): zoomed in on its zones; Full screen →
  // the Lead map on this storm.
  const [mapPoints, setMapPoints] = useState<MapPoint[] | null>(null);
  const [dayReports, setDayReports] = useState<StormReportPoint[]>([]);
  const [full, setFull] = useState(false);
  const view = useRef<MapViewState | null>(null);

  const load = useCallback(async () => {
    if (!day) return;
    const [list, rows, pts, reports] = await Promise.all([
      fetchStorms(),
      fetchStormHits(day),
      fetchMapPoints(gate.role?.isSales === true),
      loadAllReports(),
    ]);
    setStorm(list.find((s) => s.day === day) ?? null);
    setHits(rows);
    setMapPoints(pts.points);
    setDayReports(reports.filter((r) => r.day === day && r.kind === 'hail' && (r.size ?? 0) >= MIN_HAIL));
  }, [day, gate.role?.isSales]);

  const mapLayers = useMemo<StormLayers | null>(
    () =>
      dayReports.length && mapPoints
        ? { radar: false, warnings: [], reports: dayReports, highlight: new Set(inPath(mapPoints, dayReports)), fitKey: `hail:${day}` }
        : null,
    [dayReports, mapPoints, day],
  );

  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );

  if (!day) return null;
  const customers = (hits ?? []).filter((h) => h.kind === 'customer');
  const leads = (hits ?? []).filter((h) => h.kind === 'lead');
  const textable = customers.filter((c) => c.phone);

  const open = (h: StormHit) =>
    router.navigate({ pathname: '/workspace', params: { open: `${h.kind}:${h.recordId}` } } as never);

  const toggleCheck = async (h: StormHit) => {
    const on = !h.checkedAt;
    setHits((cur) => (cur ?? []).map((x) => (x === h ? { ...x, checkedAt: on ? new Date().toISOString() : null } : x)));
    const r = await checkStormHit(day, h.kind, h.recordId, on);
    if (!r.ok) {
      setNote({ ok: false, text: r.message });
      void load();
    }
  };

  const toggleStorm = async () => {
    setBusy(true);
    const r = await markStormChecked(day, !storm?.checkedAt);
    setBusy(false);
    if (r.ok) void load();
    else setNote({ ok: false, text: r.message });
  };

  const sendAll = async () => {
    setBusy(true);
    let sent = 0;
    const failed: string[] = [];
    for (let i = 0; i < textable.length; i++) {
      const c = textable[i];
      setProgress(`Sending ${i + 1} of ${textable.length}…`);
      const r = await sendSms({ customerId: c.recordId, body: text.trim() });
      if (r.ok) sent += 1;
      else failed.push(`${c.name}: ${r.message}`);
    }
    setBusy(false);
    setProgress(null);
    setTextOpen(false);
    setNote({
      ok: failed.length === 0,
      text: `Texted ${sent} customer${sent === 1 ? '' : 's'}.${failed.length ? ` Not sent — ${failed.join(' · ')}` : ''}`,
    });
  };

  const row = (h: StormHit, i: number) => (
    <View key={`${h.kind}:${h.recordId}`} style={[styles.row, i > 0 && styles.rowBorder]}>
      {h.kind === 'customer' ? (
        <Pressable onPress={() => void toggleCheck(h)} hitSlop={8} accessibilityRole="checkbox" accessibilityState={{ checked: !!h.checkedAt }}>
          <Ionicons name={h.checkedAt ? 'checkbox' : 'square-outline'} size={20} color={h.checkedAt ? colors.success : colors.inkSoft} />
        </Pressable>
      ) : null}
      <Pressable onPress={() => open(h)} style={({ pressed }) => [styles.rowBody, pressed && styles.pressed]}>
        <Text style={styles.name} numberOfLines={1}>
          {h.name}
        </Text>
        <Text style={styles.sub} numberOfLines={1}>
          {h.miles.toFixed(1)} mi · {hailLabel(h.hailSize)}
          {h.address ? ` · ${h.address}` : ''}
        </Text>
      </Pressable>
      {h.kind === 'lead' && canManage ? (
        <Text style={styles.owner} numberOfLines={1}>
          {h.owner ? personName(h.owner) : 'Unassigned'}
        </Text>
      ) : null}
      <Ionicons name="chevron-forward" size={14} color={colors.inkSoft} />
    </View>
  );

  return (
    <Screen edges={[]} contentContainerStyle={styles.content}>
      <Stack.Screen options={{ title: `${stormDayLabel(day)} hail` }} />

      {mapPoints && mapLayers ? (
        <View style={styles.mapBox}>
          <LeadMapView
            points={mapPoints}
            selectedKey={null}
            onSelect={() => {}}
            storms={mapLayers}
            labels
            onViewChange={(v) => {
              view.current = v;
            }}
          />
          <Pressable
            onPress={() => setFull(true)}
            style={({ pressed }) => [styles.fullScreen, pressed && styles.pressed]}
            accessibilityRole="button"
            accessibilityLabel="Open the map full screen">
            <Ionicons name="expand" size={14} color="#fff" />
            <Text style={styles.fullScreenText}>Full screen</Text>
          </Pressable>
          <View pointerEvents="none" style={styles.mapLegend}>
            {ZONE_LEGEND.map((l) => (
              <View key={l.label} style={styles.mapLegendItem}>
                <View style={[styles.mapLegendSwatch, { backgroundColor: l.color }]} />
                <Text style={styles.mapLegendText}>{l.label}</Text>
              </View>
            ))}
          </View>
        </View>
      ) : null}

      <Card style={styles.head}>
        <AppText variant="heading">
          {stormDayLabel(day)} · up to {hailLabel(storm?.maxHail ?? null)}
        </AppText>
        <AppText variant="caption" color={colors.textSecondary}>
          {storm?.places.slice(0, 4).join(', ') || 'Kansas City area'}
          {storm ? ` · ${storm.hailReports} hail report${storm.hailReports === 1 ? '' : 's'}` : ''}
        </AppText>
        <View style={styles.actions}>
          <Pressable
            onPress={() => router.push({ pathname: '/lead-map', params: { storm: day } } as never)}
            style={({ pressed }) => [styles.action, pressed && styles.pressed]}>
            <Ionicons name="map" size={14} color={hubColors.crm.deep} />
            <Text style={styles.actionText}>Show on the map</Text>
          </Pressable>
          {canManage && leads.length > 0 ? (
            <Pressable
              onPress={() => router.push({ pathname: '/assign-leads', params: { storm: day } } as never)}
              style={({ pressed }) => [styles.action, pressed && styles.pressed]}>
              <Ionicons name="people" size={14} color={hubColors.crm.deep} />
              <Text style={styles.actionText}>Assign these leads</Text>
            </Pressable>
          ) : null}
          {textable.length > 0 ? (
            <Pressable
              onPress={() => {
                setText(stormCheckText(day));
                setTextOpen(true);
              }}
              style={({ pressed }) => [styles.action, pressed && styles.pressed]}>
              <Ionicons name="chatbubble-ellipses" size={14} color={hubColors.crm.deep} />
              <Text style={styles.actionText}>Text these customers</Text>
            </Pressable>
          ) : null}
          {canManage ? (
            <Pressable
              onPress={() => void toggleStorm()}
              disabled={busy}
              style={({ pressed }) => [styles.action, storm?.checkedAt && styles.actionOn, (pressed || busy) && styles.pressed]}>
              <Ionicons name="checkmark-done" size={14} color={storm?.checkedAt ? colors.white : hubColors.crm.deep} />
              <Text style={[styles.actionText, storm?.checkedAt && styles.actionTextOn]}>
                {storm?.checkedAt ? 'Storm checked' : 'Mark storm checked'}
              </Text>
            </Pressable>
          ) : null}
        </View>
      </Card>

      {mapPoints && mapLayers ? (
        <MapFullScreen
          visible={full}
          onClose={() => setFull(false)}
          title={`${stormDayLabel(day)} hail · up to ${hailLabel(storm?.maxHail ?? null)}`}
          points={mapPoints}
          selectedKey={null}
          onSelect={() => {}}
          storms={mapLayers}
          labels
          initialView={view.current}
        />
      ) : null}

      {note ? <Text style={[styles.note, !note.ok && styles.noteBad]}>{note.text}</Text> : null}

      {!hits ? (
        <ActivityIndicator color={hubColors.crm.fg} style={styles.loading} />
      ) : (
        <>
          <View>
            <SectionHeader title={`Customers affected · ${customers.length}`} accent={hubColors.crm.fg} />
            <Card padded={false}>
              {customers.length === 0 ? (
                <AppText variant="body" color={colors.textSecondary} style={styles.empty}>
                  No customers in the path.
                </AppText>
              ) : (
                customers.map(row)
              )}
            </Card>
          </View>
          <View>
            <SectionHeader title={`Leads affected · ${leads.length}`} accent={hubColors.crm.fg} />
            <Card padded={false}>
              {leads.length === 0 ? (
                <AppText variant="body" color={colors.textSecondary} style={styles.empty}>
                  No leads in the path.
                </AppText>
              ) : (
                leads.map(row)
              )}
            </Card>
          </View>
        </>
      )}

      <Modal visible={textOpen} transparent animationType="slide" onRequestClose={() => !busy && setTextOpen(false)}>
        <Pressable style={styles.backdrop} onPress={() => !busy && setTextOpen(false)} />
        <View style={[styles.sheet, { paddingBottom: spacing.md + insets.bottom }]}>
          <View style={styles.sheetHead}>
            <Text style={styles.sheetTitle}>
              Text {textable.length} customer{textable.length === 1 ? '' : 's'}
            </Text>
            <Pressable onPress={() => setTextOpen(false)} hitSlop={8} disabled={busy}>
              <Ionicons name="close" size={20} color={colors.inkSoft} />
            </Pressable>
          </View>
          <AppText variant="caption" color={colors.textSecondary}>
            Each customer gets this text on their own, from your DC Solar number. Edit it first if you like.
          </AppText>
          <TextInput value={text} onChangeText={setText} multiline style={styles.textBox} textAlignVertical="top" />
          <Pressable
            onPress={() => void sendAll()}
            disabled={busy || !text.trim()}
            style={({ pressed }) => [styles.send, (pressed || busy || !text.trim()) && styles.pressed]}>
            {busy ? (
              <Text style={styles.sendText}>{progress ?? 'Sending…'}</Text>
            ) : (
              <Text style={styles.sendText}>
                Send to {textable.length} customer{textable.length === 1 ? '' : 's'}
              </Text>
            )}
          </Pressable>
        </View>
      </Modal>
    </Screen>
  );
}

const styles = StyleSheet.create({
  content: { width: '100%', maxWidth: 680, alignSelf: 'center', gap: spacing.md, paddingBottom: spacing.xl },
  loading: { marginVertical: spacing.xl },
  head: { gap: spacing.xs },
  mapBox: { height: 280, borderRadius: radii.md, overflow: 'hidden' },
  fullScreen: {
    position: 'absolute',
    right: spacing.sm,
    bottom: spacing.sm,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    backgroundColor: 'rgba(0,0,0,0.7)',
    borderRadius: radii.pill,
    paddingHorizontal: 12,
    paddingVertical: 7,
  },
  fullScreenText: { color: '#fff', fontSize: 12, fontWeight: '800' },
  mapLegend: {
    position: 'absolute',
    left: spacing.sm,
    bottom: spacing.sm,
    flexDirection: 'row',
    gap: 8,
    backgroundColor: 'rgba(0,0,0,0.6)',
    borderRadius: radii.pill,
    paddingHorizontal: 10,
    paddingVertical: 5,
  },
  mapLegendItem: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  mapLegendSwatch: { width: 9, height: 9, borderRadius: 5 },
  mapLegendText: { color: '#fff', fontSize: 10, fontWeight: '700' },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm, marginTop: spacing.sm },
  action: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    paddingHorizontal: spacing.sm + 2,
    paddingVertical: 7,
    borderRadius: radii.pill,
    backgroundColor: hubColors.crm.bg,
  },
  actionOn: { backgroundColor: colors.success },
  actionText: { color: hubColors.crm.deep, fontSize: 12, fontWeight: '800' },
  actionTextOn: { color: colors.white },
  note: { color: colors.success, fontSize: 13, fontWeight: '800' },
  noteBad: { color: colors.danger },
  empty: { padding: spacing.md },
  row: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, paddingHorizontal: spacing.md, paddingVertical: spacing.sm + 2, backgroundColor: colors.surface },
  rowBorder: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.line },
  rowBody: { flex: 1, minWidth: 0 },
  name: { color: colors.ink, fontSize: 14, fontWeight: '800' },
  sub: { color: colors.inkSoft, fontSize: 12, fontWeight: '600', marginTop: 1 },
  owner: { color: colors.inkSoft, fontSize: 11, fontWeight: '800', maxWidth: 80 },
  pressed: { opacity: 0.6 },
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.45)' },
  sheet: {
    backgroundColor: colors.surface,
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    paddingHorizontal: spacing.md,
    paddingTop: spacing.md,
    gap: spacing.sm,
  },
  sheetHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  sheetTitle: { color: colors.ink, fontSize: 17, fontWeight: '800' },
  textBox: {
    minHeight: 120,
    backgroundColor: colors.canvas,
    borderRadius: radii.sm,
    borderWidth: 1,
    borderColor: colors.line,
    padding: spacing.sm + 2,
    color: colors.ink,
    fontSize: 14,
  },
  send: { backgroundColor: colors.sun, borderRadius: radii.pill, paddingVertical: spacing.sm + 4, alignItems: 'center' },
  sendText: { color: colors.textOnAction, fontSize: 14, fontWeight: '800' },
});
