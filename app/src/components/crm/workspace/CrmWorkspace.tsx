import Ionicons from '@expo/vector-icons/Ionicons';
import { useFocusEffect, useRouter } from 'expo-router';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View, useWindowDimensions } from 'react-native';

import { DetailPanel } from '@/components/crm/workspace/DetailPanel';
import { RecordList } from '@/components/crm/workspace/RecordList';
import { WorkspaceCenter } from '@/components/crm/workspace/WorkspaceCenter';
import { colors, spacing } from '@/constants/theme';
import { fetchAssignmentsByJob, type Assignment } from '@/lib/assignments';
import {
  fetchCommsSettings,
  fetchTemplates,
  fetchThread,
  useCommsRealtime,
  type CommsMessage,
  type CommsSettings,
  type MessageTemplate,
} from '@/lib/comms';
import {
  fetchCustomerFinance,
  fetchCustomerJobs,
  fetchCustomerNotes,
  type CustomerFinanceRow,
  type CustomerJob,
  type CustomerNote,
} from '@/lib/crm';
import {
  composeActivity,
  fetchWorkspaceRecords,
  filterRecords,
  type ActivityEvent,
  type RecordKind,
  type WorkspaceRecord,
} from '@/lib/crmWorkspace';
import { fetchCustomerDocuments, type CustomerDocument } from '@/lib/customers';
import { fetchEmployeeOptions } from '@/lib/myhours';
import { useRole } from '@/lib/role';

/**
 * The CRM workspace: list · conversation/activity · details, on one screen.
 *
 * THIS COMPONENT OWNS SELECTION AND FETCHING; the three columns are dumb.
 * The list is one composed read (`fetchWorkspaceRecords`); selecting a
 * record loads its thread, notes, jobs, money rows and documents once and
 * hands them down. The timeline is derived from those same loads
 * (`composeActivity`) — no extra round trips, no activity table.
 *
 * THREE LAYOUTS FROM ONE STATE, chosen by width, so nothing about the data
 * flow cares whether it is on a 27" monitor or a phone:
 *   ≥ 1100  list | center | detail
 *   ≥ 760   list | center, detail slides in over the center on demand
 *   < 760   list, then the record full-width with a back button
 *
 * Web-first (2026-09-07): reachable from the CRM tab, which the tab bar only
 * shows on web. The route still renders on a phone (a deep link, a future
 * native tab) and just gets the narrow layout.
 */

const WIDE = 1100;
const MEDIUM = 760;

export function CrmWorkspace() {
  const role = useRole();
  const router = useRouter();
  const { width } = useWindowDimensions();
  const layout: 'wide' | 'medium' | 'narrow' = width >= WIDE ? 'wide' : width >= MEDIUM ? 'medium' : 'narrow';

  const [records, setRecords] = useState<WorkspaceRecord[]>([]);
  const [hasMoney, setHasMoney] = useState(false);
  const [listStatus, setListStatus] = useState<'loading' | 'ok' | 'unavailable'>('loading');
  const [search, setSearch] = useState('');
  const [kind, setKind] = useState<RecordKind | 'all'>('all');
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [detailOpen, setDetailOpen] = useState(false);

  const [settings, setSettings] = useState<CommsSettings | null>(null);
  const [templates, setTemplates] = useState<MessageTemplate[]>([]);
  const [reps, setReps] = useState<{ email: string; name: string }[]>([]);
  const [assignments, setAssignments] = useState<Map<string, Assignment[]>>(new Map());
  const [documents, setDocuments] = useState<Map<string, CustomerDocument[]>>(new Map());

  // Per-selection loads.
  const [messages, setMessages] = useState<CommsMessage[]>([]);
  const [notes, setNotes] = useState<CustomerNote[]>([]);
  const [notesAvailable, setNotesAvailable] = useState(true);
  const [jobs, setJobs] = useState<CustomerJob[]>([]);
  const [finance, setFinance] = useState<CustomerFinanceRow[]>([]);
  const [detailLoading, setDetailLoading] = useState(false);

  const loadList = useCallback(async () => {
    const [result, s, t, r, a, d] = await Promise.all([
      fetchWorkspaceRecords(),
      fetchCommsSettings(),
      fetchTemplates(),
      fetchEmployeeOptions(),
      fetchAssignmentsByJob(),
      fetchCustomerDocuments(),
    ]);
    setRecords(result.records);
    setHasMoney(result.hasMoney);
    setListStatus(result.status === 'ok' ? 'ok' : 'unavailable');
    setSettings(s);
    setTemplates(t);
    setReps(r);
    setAssignments(a ?? new Map());
    setDocuments(d ?? new Map());
  }, []);

  useFocusEffect(
    useCallback(() => {
      void loadList();
    }, [loadList]),
  );

  const selected = useMemo(() => records.find((r) => r.key === selectedKey) ?? null, [records, selectedKey]);

  const loadSelected = useCallback(async (record: WorkspaceRecord) => {
    setDetailLoading(true);
    if (record.kind === 'customer') {
      const [thread, noteResult, jobRows] = await Promise.all([
        fetchThread(record.id),
        fetchCustomerNotes(record.id),
        fetchCustomerJobs(record.id),
      ]);
      const financeResult = await fetchCustomerFinance(record.id, jobRows.map((j) => j.id));
      setMessages(thread);
      setNotes(noteResult.status === 'ok' ? noteResult.notes : []);
      setNotesAvailable(noteResult.status === 'ok');
      setJobs(jobRows);
      setFinance(financeResult.status === 'ok' ? financeResult.entries : []);
    } else {
      const thread = await fetchThread(record.id, { byLead: true });
      setMessages(thread);
      setNotes([]);
      setNotesAvailable(true);
      setJobs([]);
      setFinance([]);
    }
    setDetailLoading(false);
  }, []);

  useEffect(() => {
    if (selected) void loadSelected(selected);
  }, [selected?.key, loadSelected]); // eslint-disable-line react-hooks/exhaustive-deps

  // A reply, a delivery receipt, a call ending: refresh the list ordering
  // and the open record's timeline. The focus refetch stays the source of
  // truth.
  useCommsRealtime(
    useCallback(() => {
      void loadList();
      if (selected) void loadSelected(selected);
    }, [loadList, loadSelected, selected]),
  );

  const refreshAll = useCallback(async () => {
    await loadList();
    if (selected) await loadSelected(selected);
  }, [loadList, loadSelected, selected]);

  const events: ActivityEvent[] = useMemo(
    () => (selected ? composeActivity({ messages, notes, jobs, finance, lead: selected.lead }) : []),
    [selected, messages, notes, jobs, finance],
  );

  const visible = useMemo(() => filterRecords(records, search, kind), [records, search, kind]);
  const totals = useMemo(
    () => ({
      customers: records.filter((r) => r.kind === 'customer').length,
      leads: records.filter((r) => r.kind === 'lead').length,
    }),
    [records],
  );

  if (role && !role.isAdmin) {
    return (
      <View style={styles.center}>
        <Ionicons name="lock-closed" size={26} color={colors.ocean} />
        <Text style={styles.centerTitle}>Admins only</Text>
        <Text style={styles.centerBody}>
          The CRM workspace carries customer conversations, which hold prices and addresses, so it is
          limited to owners and operators.
        </Text>
      </View>
    );
  }

  if (listStatus === 'loading') {
    return (
      <View style={styles.center}>
        <ActivityIndicator color={colors.ocean} />
      </View>
    );
  }

  if (listStatus === 'unavailable') {
    return (
      <View style={styles.center}>
        <Ionicons name="cloud-offline-outline" size={26} color={colors.inkSoft} />
        <Text style={styles.centerTitle}>Could not load customers</Text>
        <Text style={styles.centerBody}>Check the connection and try again.</Text>
        <Pressable onPress={() => void loadList()} style={({ pressed }) => [styles.retry, pressed && styles.pressed]}>
          <Text style={styles.retryText}>Retry</Text>
        </Pressable>
      </View>
    );
  }

  const list = (
    <RecordList
      records={visible}
      total={totals}
      selectedKey={selectedKey}
      onSelect={(r) => {
        setSelectedKey(r.key);
        setDetailOpen(false);
      }}
      search={search}
      onSearch={setSearch}
      kind={kind}
      onKind={setKind}
      onNewLead={() => router.push('/leads' as never)}
    />
  );

  const placeholder = (
    <View style={styles.center}>
      <Ionicons name="people-outline" size={26} color={colors.inkSoft} />
      <Text style={styles.centerTitle}>Pick a customer or lead</Text>
      <Text style={styles.centerBody}>
        Their texts, calls, notes, jobs and paperwork show up here, in one place.
      </Text>
    </View>
  );

  const center = selected ? (
    <WorkspaceCenter
      record={selected}
      settings={settings}
      templates={templates}
      tech={role?.displayName ?? null}
      notes={notes}
      notesAvailable={notesAvailable}
      events={events}
      loading={detailLoading}
      onNotesChanged={() => void loadSelected(selected)}
      onOpenDetail={layout === 'wide' ? undefined : () => setDetailOpen(true)}
    />
  ) : (
    placeholder
  );

  const detail = selected ? (
    <DetailPanel
      record={selected}
      jobs={jobs}
      finance={finance}
      documents={documents.get(selected.id) ?? []}
      assignments={assignments.get(selected.currentJob?.id ?? '') ?? []}
      reps={reps}
      hasMoney={hasMoney}
      onChanged={() => void refreshAll()}
      onClose={layout === 'wide' ? undefined : () => setDetailOpen(false)}
    />
  ) : null;

  if (layout === 'wide') {
    return (
      <View style={styles.row}>
        <View style={[styles.col, styles.listCol]}>{list}</View>
        <View style={[styles.col, styles.centerCol]}>{center}</View>
        <View style={[styles.col, styles.detailCol]}>{detail ?? <View style={styles.detailEmpty} />}</View>
      </View>
    );
  }

  if (layout === 'medium') {
    return (
      <View style={styles.row}>
        <View style={[styles.col, styles.listColMedium]}>{list}</View>
        <View style={[styles.col, styles.centerCol]}>{detailOpen && detail ? detail : center}</View>
      </View>
    );
  }

  // Narrow: one column at a time.
  if (!selected) return <View style={styles.single}>{list}</View>;
  return (
    <View style={styles.single}>
      <Pressable onPress={() => setSelectedKey(null)} style={({ pressed }) => [styles.back, pressed && styles.pressed]}>
        <Ionicons name="chevron-back" size={16} color={colors.ocean} />
        <Text style={styles.backText}>All records</Text>
      </Pressable>
      <View style={styles.single}>{detailOpen && detail ? detail : center}</View>
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flex: 1, flexDirection: 'row', backgroundColor: colors.cream },
  single: { flex: 1, backgroundColor: colors.cream },
  col: { height: '100%' },
  listCol: { width: 320, borderRightWidth: StyleSheet.hairlineWidth, borderRightColor: colors.line },
  listColMedium: { width: 280, borderRightWidth: StyleSheet.hairlineWidth, borderRightColor: colors.line },
  centerCol: { flex: 1, minWidth: 0 },
  detailCol: { width: 340, borderLeftWidth: StyleSheet.hairlineWidth, borderLeftColor: colors.line },
  detailEmpty: { flex: 1, backgroundColor: colors.canvas },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: spacing.sm, padding: spacing.xl, backgroundColor: colors.cream },
  centerTitle: { color: colors.ink, fontSize: 16, fontWeight: '800', textAlign: 'center' },
  centerBody: { color: colors.inkSoft, fontSize: 13, fontWeight: '600', textAlign: 'center', lineHeight: 18, maxWidth: 360 },
  retry: { marginTop: spacing.sm, backgroundColor: colors.sun, borderRadius: 999, paddingHorizontal: spacing.lg, paddingVertical: spacing.sm },
  retryText: { color: colors.ink, fontSize: 13, fontWeight: '800' },
  back: { flexDirection: 'row', alignItems: 'center', gap: 4, padding: spacing.sm, paddingHorizontal: spacing.md },
  backText: { color: colors.ocean, fontSize: 13, fontWeight: '700' },
  pressed: { opacity: 0.6 },
});
