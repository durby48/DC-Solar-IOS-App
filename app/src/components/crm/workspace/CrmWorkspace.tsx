import Ionicons from '@expo/vector-icons/Ionicons';
import { useFocusEffect, useRouter } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Platform, Pressable, StyleSheet, Text, View, useWindowDimensions } from 'react-native';

import { DetailPanel } from '@/components/crm/workspace/DetailPanel';
import { RecordList, type ListMode } from '@/components/crm/workspace/RecordList';
import { TasksPane } from '@/components/crm/workspace/TasksPane';
import { WorkspaceCenter } from '@/components/crm/workspace/WorkspaceCenter';
import { PipelineBoard } from '@/components/PipelineBoard';
import { colors, hubColors, radii, spacing } from '@/constants/theme';
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
  fetchJobStageHistory,
  fetchLeadStatusHistory,
  fetchWorkspaceRecords,
  filterRecords,
  type ActivityEvent,
  type StageChange,
  type WorkspaceRecord,
} from '@/lib/crmWorkspace';
import { fetchRecordEmailThreads, type RecordEmailResult } from '@/lib/crmEmail';
import { fetchCustomerDocuments, type CustomerDocument } from '@/lib/customers';
import { fetchLeadAppointments, type LeadAppointment } from '@/lib/leadAppointments';
import { fetchEmployeeOptions } from '@/lib/myhours';
import { fetchJobsBoardData, type JobsBoardData } from '@/lib/pipeline';
import { useRole } from '@/lib/role';
import { isCompanyJob, stageOrDefault } from '@/lib/stages';
import { countDueNow, fetchTasks, type Task } from '@/lib/tasks';
import { type Job } from '@/lib/types';

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
 *
 * JOBS LENS (2026-09-12). A fifth chip on the list swaps the centre and
 * detail columns for the Pipeline's stage-column board (`PipelineBoard`,
 * the same component the Pipeline tab renders at desk width), fed by
 * `fetchJobsBoardData` — loaded the first time the lens is opened, refetched
 * after a card moves column. Clicking a card, or the customer line on it,
 * selects that customer in the list and returns to the record lens, so the
 * board is a way INTO a record, not a second Pipeline. The lens is remembered
 * with the selection. The Pipeline tab stays the crew's field view.
 */

const WIDE = 1100;
const MEDIUM = 760;

/**
 * Where you were (Phase 8): the last selected record and lens survive a
 * reload, a tab change and coming back tomorrow — per browser, web only.
 * Read once when the list first loads; a record that no longer exists is
 * simply ignored.
 */
const REMEMBER_KEY = 'dcsolar.crm.workspace';
function remembered(): { selectedKey: string | null; kind: ListMode } {
  try {
    if (Platform.OS !== 'web' || typeof localStorage === 'undefined') return { selectedKey: null, kind: 'all' };
    const raw = localStorage.getItem(REMEMBER_KEY);
    if (!raw) return { selectedKey: null, kind: 'all' };
    const parsed = JSON.parse(raw) as { selectedKey?: unknown; kind?: unknown };
    const kind = parsed.kind;
    return {
      selectedKey: typeof parsed.selectedKey === 'string' ? parsed.selectedKey : null,
      kind: kind === 'customer' || kind === 'lead' || kind === 'tasks' || kind === 'jobs' ? kind : 'all',
    };
  } catch {
    return { selectedKey: null, kind: 'all' };
  }
}
function remember(state: { selectedKey: string | null; kind: ListMode }): void {
  try {
    if (Platform.OS !== 'web' || typeof localStorage === 'undefined') return;
    localStorage.setItem(REMEMBER_KEY, JSON.stringify(state));
  } catch {
    // Private mode, quota, blocked storage: forgetting is fine.
  }
}

export function CrmWorkspace() {
  const role = useRole();
  const router = useRouter();
  const { width } = useWindowDimensions();
  const layout: 'wide' | 'medium' | 'narrow' = width >= WIDE ? 'wide' : width >= MEDIUM ? 'medium' : 'narrow';

  const [records, setRecords] = useState<WorkspaceRecord[]>([]);
  const [hasMoney, setHasMoney] = useState(false);
  const [listStatus, setListStatus] = useState<'loading' | 'ok' | 'unavailable'>('loading');
  const [search, setSearch] = useState('');
  const [kind, setKind] = useState<ListMode>(() => remembered().kind);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const restored = useRef(false);
  const [detailOpen, setDetailOpen] = useState(false);

  const [settings, setSettings] = useState<CommsSettings | null>(null);
  const [templates, setTemplates] = useState<MessageTemplate[]>([]);
  const [reps, setReps] = useState<{ email: string; name: string }[]>([]);
  const [assignments, setAssignments] = useState<Map<string, Assignment[]>>(new Map());
  const [documents, setDocuments] = useState<Map<string, CustomerDocument[]>>(new Map());
  // Every task the caller may read (RLS: all for admins). The record's own
  // tasks are a filter over this, so a tick anywhere refreshes one read.
  const [tasks, setTasks] = useState<Task[]>([]);
  // The Jobs lens's board data. Null until the lens is first opened.
  const [board, setBoard] = useState<JobsBoardData | null>(null);
  const [boardLoading, setBoardLoading] = useState(false);

  // Per-selection loads.
  const [messages, setMessages] = useState<CommsMessage[]>([]);
  const [notes, setNotes] = useState<CustomerNote[]>([]);
  const [notesAvailable, setNotesAvailable] = useState(true);
  const [jobs, setJobs] = useState<CustomerJob[]>([]);
  const [finance, setFinance] = useState<CustomerFinanceRow[]>([]);
  const [history, setHistory] = useState<StageChange[]>([]);
  const [appointments, setAppointments] = useState<LeadAppointment[]>([]);
  const [detailLoading, setDetailLoading] = useState(false);
  // Email is read live from Gmail (a couple of seconds), so it loads beside
  // the record's other data rather than holding it up. null = loading.
  const [email, setEmail] = useState<RecordEmailResult | null>(null);
  const emailFor = useRef<string | null>(null);
  const detailFor = useRef<string | null>(null);

  const loadTasks = useCallback(async () => {
    const result = await fetchTasks({ all: true });
    setTasks(result.status === 'ok' ? result.tasks : []);
  }, []);

  const loadList = useCallback(async () => {
    const [result, s, t, r, a, d] = await Promise.all([
      fetchWorkspaceRecords(),
      fetchCommsSettings(),
      fetchTemplates(),
      fetchEmployeeOptions(),
      fetchAssignmentsByJob(),
      fetchCustomerDocuments(),
      loadTasks(),
    ]);
    setRecords(result.records);
    setHasMoney(result.hasMoney);
    setListStatus(result.status === 'ok' ? 'ok' : 'unavailable');
    setSettings(s);
    setTemplates(t);
    setReps(r);
    setAssignments(a ?? new Map());
    setDocuments(d ?? new Map());
  }, [loadTasks]);

  const loadBoard = useCallback(async () => {
    setBoardLoading(true);
    const data = await fetchJobsBoardData({ admin: role?.isAdmin === true });
    setBoard(data);
    setBoardLoading(false);
  }, [role?.isAdmin]);

  useFocusEffect(
    useCallback(() => {
      void loadList();
      // A stage edit made elsewhere (job editor, Pipeline tab) should be on
      // the board when the tab regains focus — but only if it is showing.
      if (kind === 'jobs') void loadBoard();
    }, [loadList, loadBoard, kind]),
  );

  // First open of the Jobs lens (including a remembered one).
  useEffect(() => {
    if (kind === 'jobs' && board === null && !boardLoading) void loadBoard();
  }, [kind, board, boardLoading, loadBoard]);

  const selected = useMemo(() => records.find((r) => r.key === selectedKey) ?? null, [records, selectedKey]);

  /** A board card (or its customer line) → that customer, in the record lens. */
  const selectCustomerFromBoard = useCallback(
    (customerId: string) => {
      const key = `customer:${customerId}`;
      setKind('all');
      setDetailOpen(false);
      if (records.some((r) => r.key === key)) {
        setSelectedKey(key);
      } else {
        // Archived, or created since the list loaded: the record screen still has it.
        router.push({ pathname: '/crm/[id]', params: { id: customerId } });
      }
    },
    [records, router],
  );
  const openJobFromBoard = useCallback(
    (job: Job) => {
      if (job.customer_id) selectCustomerFromBoard(job.customer_id);
      else router.push({ pathname: '/job/[id]', params: { id: job.id } });
    },
    [router, selectCustomerFromBoard],
  );

  // Restore the last record once the list is in; remember every change after.
  useEffect(() => {
    if (restored.current || records.length === 0) return;
    restored.current = true;
    const last = remembered().selectedKey;
    if (last && !selectedKey && records.some((r) => r.key === last)) setSelectedKey(last);
  }, [records, selectedKey]);
  useEffect(() => {
    if (restored.current) remember({ selectedKey, kind });
  }, [selectedKey, kind]);

  const loadSelected = useCallback(async (record: WorkspaceRecord) => {
    // Same guard as loadEmail: clicking A then B quickly must not land A's
    // messages, notes and money under B when A's slower fetch resolves last.
    detailFor.current = record.key;
    setDetailLoading(true);
    if (record.kind === 'customer') {
      const [thread, noteResult, jobRows] = await Promise.all([
        fetchThread(record.id),
        fetchCustomerNotes(record.id),
        fetchCustomerJobs(record.id),
      ]);
      const jobIds = jobRows.map((j) => j.id);
      const [financeResult, stageHistory] = await Promise.all([
        fetchCustomerFinance(record.id, jobIds),
        fetchJobStageHistory(jobIds),
      ]);
      if (detailFor.current !== record.key) return;
      setMessages(thread);
      setNotes(noteResult.status === 'ok' ? noteResult.notes : []);
      setNotesAvailable(noteResult.status === 'ok');
      setJobs(jobRows);
      setFinance(financeResult.status === 'ok' ? financeResult.entries : []);
      setHistory(stageHistory);
      setAppointments([]);
    } else {
      const [thread, statusHistory, appts] = await Promise.all([
        fetchThread(record.id, { byLead: true }),
        fetchLeadStatusHistory(record.id),
        fetchLeadAppointments(record.id),
      ]);
      if (detailFor.current !== record.key) return;
      setMessages(thread);
      setNotes([]);
      setNotesAvailable(true);
      setJobs([]);
      setFinance([]);
      setHistory(statusHistory);
      setAppointments(appts.status === 'ok' ? appts.appointments : []);
    }
    setDetailLoading(false);
  }, []);

  const loadEmail = useCallback(async (record: WorkspaceRecord) => {
    emailFor.current = record.key;
    setEmail(null);
    const result = await fetchRecordEmailThreads(record.email);
    // The user may have clicked on; a slow Gmail answer must not land on the wrong record.
    if (emailFor.current === record.key) setEmail(result);
  }, []);

  useEffect(() => {
    if (selected) void loadEmail(selected);
  }, [selected?.key, loadEmail]); // eslint-disable-line react-hooks/exhaustive-deps

  const loadAppointments = useCallback(async (record: WorkspaceRecord) => {
    if (record.kind !== 'lead') return;
    const appts = await fetchLeadAppointments(record.id);
    setAppointments(appts.status === 'ok' ? appts.appointments : []);
  }, []);

  useEffect(() => {
    if (selected) void loadSelected(selected);
  }, [selected?.key, loadSelected]); // eslint-disable-line react-hooks/exhaustive-deps

  // A reply, a delivery receipt, a call ending: refresh the list ordering
  // and the open record's timeline. The focus refetch stays the source of
  // truth. COALESCED: the subscription fires on every `messages` row change
  // company-wide, and one outbound text produces queued → sent → delivered
  // in a few seconds — each of which used to reload the whole workspace
  // (about fifteen queries). One trailing reload per burst instead.
  const realtimeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (realtimeTimer.current) clearTimeout(realtimeTimer.current);
  }, []);
  useCommsRealtime(
    useCallback(() => {
      if (realtimeTimer.current) clearTimeout(realtimeTimer.current);
      realtimeTimer.current = setTimeout(() => {
        realtimeTimer.current = null;
        void loadList();
        if (selected) void loadSelected(selected);
      }, 1500);
    }, [loadList, loadSelected, selected]),
  );

  const refreshAll = useCallback(async () => {
    await loadList();
    if (selected) await loadSelected(selected);
  }, [loadList, loadSelected, selected]);

  const recordTasks = useMemo(
    () =>
      selected
        ? tasks.filter((t) => (selected.kind === 'customer' ? t.customer_id === selected.id : t.lead_id === selected.id))
        : [],
    [selected, tasks],
  );

  const events: ActivityEvent[] = useMemo(
    () =>
      selected
        ? composeActivity({
            messages,
            notes,
            jobs,
            finance,
            lead: selected.lead,
            history,
            tasks: recordTasks,
            appointments,
            emails: email?.status === 'ok' ? { mailbox: email.mailbox, threads: email.threads } : undefined,
          })
        : [],
    [selected, messages, notes, jobs, finance, history, recordTasks, appointments, email],
  );

  const visible = useMemo(
    () =>
      filterRecords(
        records,
        kind === 'tasks' || kind === 'jobs' ? '' : search,
        kind === 'tasks' || kind === 'jobs' ? 'all' : kind,
      ),
    [records, search, kind],
  );
  // On the Jobs lens the search box filters the board, not the list.
  const boardJobs = useMemo(() => {
    if (!board) return [];
    const q = search.trim().toLowerCase();
    if (!q) return board.jobs;
    return board.jobs.filter(
      (j) =>
        j.name.toLowerCase().includes(q) ||
        j.job_number?.toLowerCase().includes(q) ||
        j.customer?.name.toLowerCase().includes(q) ||
        j.address?.toLowerCase().includes(q),
    );
  }, [board, search]);
  const openJobCount = useMemo(
    () =>
      board
        ? board.jobs.filter((j) => !isCompanyJob(j) && stageOrDefault(j.stage, j.status) !== 'Complete').length
        : undefined,
    [board],
  );
  const taskBadge = useMemo(() => countDueNow(tasks), [tasks]);
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
        <Ionicons name="lock-closed" size={26} color={hubColors.crm.fg} />
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
        <ActivityIndicator color={hubColors.crm.fg} />
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
      taskBadge={taskBadge}
      jobsLens
      jobCount={openJobCount}
      tasksPane={
        <TasksPane
          tasks={tasks}
          records={records}
          reps={reps}
          myEmail={role?.email ?? null}
          query={search}
          onChanged={() => void loadTasks()}
          onSelectRecord={(r) => {
            setSelectedKey(r.key);
            setDetailOpen(false);
          }}
        />
      }
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
      email={email}
      onNotesChanged={() => void loadSelected(selected)}
      onEmailChanged={() => void loadEmail(selected)}
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
      tasks={recordTasks}
      appointments={appointments}
      myEmail={role?.email ?? null}
      canEditStage={role?.isAdmin === true}
      onChanged={() => void refreshAll()}
      onTasksChanged={() => void loadTasks()}
      onAppointmentsChanged={() => void loadAppointments(selected)}
      onClose={layout === 'wide' ? undefined : () => setDetailOpen(false)}
    />
  ) : null;

  // The Jobs lens: the Pipeline's board where the centre and detail columns
  // were. Same props as the Pipeline tab hands it, plus the two callbacks
  // that turn a click into a selection here instead of a navigation.
  const boardPane = (
    <View style={styles.boardPane}>
      <View style={styles.boardHead}>
        <View style={styles.boardTitleRow}>
          <View style={styles.boardDot} />
          <Text style={styles.boardTitle}>Jobs board</Text>
          {board ? (
            <Text style={styles.boardMeta}>
              {openJobCount ?? 0} open · click a card to open its customer
            </Text>
          ) : null}
        </View>
        <View style={styles.boardActions}>
          <Pressable
            onPress={() => void loadBoard()}
            disabled={boardLoading}
            hitSlop={6}
            accessibilityLabel="Refresh the board"
            style={({ pressed }) => [styles.boardAction, pressed && styles.pressed]}>
            {boardLoading ? (
              <ActivityIndicator size="small" color={hubColors.pipeline.fg} />
            ) : (
              <Ionicons name="refresh" size={15} color={hubColors.pipeline.fg} />
            )}
          </Pressable>
          <Pressable
            onPress={() => router.push('/pipeline' as never)}
            hitSlop={6}
            accessibilityLabel="Open the Pipeline tab"
            style={({ pressed }) => [styles.boardAction, pressed && styles.pressed]}>
            <Text style={styles.boardActionText}>Pipeline</Text>
            <Ionicons name="open-outline" size={13} color={hubColors.pipeline.fg} />
          </Pressable>
          {role?.isAdmin ? (
            <Pressable
              onPress={() => router.push('/job-editor' as never)}
              hitSlop={6}
              accessibilityLabel="New project"
              style={({ pressed }) => [styles.boardAction, styles.boardActionPrimary, pressed && styles.pressed]}>
              <Ionicons name="add" size={15} color={colors.white} />
              <Text style={[styles.boardActionText, styles.boardActionTextPrimary]}>New project</Text>
            </Pressable>
          ) : null}
        </View>
      </View>
      {board ? (
        <>
          <PipelineBoard
            jobs={boardJobs}
            nextDates={board.nextDates}
            money={board.money}
            artUrls={board.artUrls}
            labor={board.labor}
            model={board.model}
            isAdmin={role?.isAdmin === true}
            onChanged={() => void loadBoard()}
            onOpenJob={openJobFromBoard}
            onOpenCustomer={selectCustomerFromBoard}
          />
          {board.status === 'unavailable' ? (
            <Text style={styles.boardEmpty}>Could not load the pipeline. Refresh to retry.</Text>
          ) : board.jobs.length === 0 ? (
            <Text style={styles.boardEmpty}>No projects yet.</Text>
          ) : boardJobs.length === 0 ? (
            <Text style={styles.boardEmpty}>No project matches that search.</Text>
          ) : null}
        </>
      ) : (
        <View style={styles.center}>
          <ActivityIndicator color={hubColors.pipeline.fg} />
        </View>
      )}
    </View>
  );

  if (layout === 'wide') {
    return (
      <View style={styles.row}>
        <View style={[styles.col, styles.listCol]}>{list}</View>
        {kind === 'jobs' ? (
          <View style={[styles.col, styles.centerCol]}>{boardPane}</View>
        ) : (
          <>
            <View style={[styles.col, styles.centerCol]}>{center}</View>
            <View style={[styles.col, styles.detailCol]}>{detail ?? <View style={styles.detailEmpty} />}</View>
          </>
        )}
      </View>
    );
  }

  if (layout === 'medium') {
    return (
      <View style={styles.row}>
        <View style={[styles.col, styles.listColMedium]}>{list}</View>
        <View style={[styles.col, styles.centerCol]}>
          {kind === 'jobs' ? boardPane : detailOpen && detail ? detail : center}
        </View>
      </View>
    );
  }

  // Narrow: one column at a time. The board scrolls sideways on its own.
  if (kind === 'jobs') {
    return (
      <View style={styles.single}>
        <Pressable onPress={() => setKind('all')} style={({ pressed }) => [styles.back, pressed && styles.pressed]}>
          <Ionicons name="chevron-back" size={16} color={hubColors.crm.fg} />
          <Text style={styles.backText}>All records</Text>
        </Pressable>
        <View style={styles.single}>{boardPane}</View>
      </View>
    );
  }
  if (!selected) return <View style={styles.single}>{list}</View>;
  return (
    <View style={styles.single}>
      <Pressable onPress={() => setSelectedKey(null)} style={({ pressed }) => [styles.back, pressed && styles.pressed]}>
        <Ionicons name="chevron-back" size={16} color={hubColors.crm.fg} />
        <Text style={styles.backText}>All records</Text>
      </Pressable>
      <View style={styles.single}>{detailOpen && detail ? detail : center}</View>
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flex: 1, flexDirection: 'row', backgroundColor: colors.surfaceAlt },
  single: { flex: 1, backgroundColor: colors.surfaceAlt },
  col: { height: '100%' },
  listCol: { width: 320, borderRightWidth: StyleSheet.hairlineWidth, borderRightColor: colors.line },
  listColMedium: { width: 280, borderRightWidth: StyleSheet.hairlineWidth, borderRightColor: colors.line },
  centerCol: { flex: 1, minWidth: 0 },
  detailCol: { width: 340, borderLeftWidth: StyleSheet.hairlineWidth, borderLeftColor: colors.line },
  detailEmpty: { flex: 1, backgroundColor: colors.canvas },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: spacing.sm, padding: spacing.xl, backgroundColor: colors.surfaceAlt },
  centerTitle: { color: colors.ink, fontSize: 16, fontWeight: '800', textAlign: 'center' },
  centerBody: { color: colors.inkSoft, fontSize: 13, fontWeight: '600', textAlign: 'center', lineHeight: 18, maxWidth: 360 },
  retry: { marginTop: spacing.sm, backgroundColor: colors.sun, borderRadius: 999, paddingHorizontal: spacing.lg, paddingVertical: spacing.sm },
  retryText: { color: colors.ink, fontSize: 13, fontWeight: '800' },
  back: { flexDirection: 'row', alignItems: 'center', gap: 4, padding: spacing.sm, paddingHorizontal: spacing.md },
  backText: { color: hubColors.crm.fg, fontSize: 13, fontWeight: '700' },
  pressed: { opacity: 0.6 },

  // ---- Jobs lens ----
  boardPane: { flex: 1, backgroundColor: colors.surfaceAlt, paddingTop: spacing.md },
  boardHead: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    flexWrap: 'wrap',
    gap: spacing.sm,
    paddingHorizontal: spacing.lg,
    paddingBottom: spacing.md,
  },
  boardTitleRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, flexShrink: 1 },
  boardDot: { width: 10, height: 10, borderRadius: 5, backgroundColor: hubColors.pipeline.fg },
  boardTitle: { color: colors.ink, fontSize: 16, fontWeight: '800' },
  boardMeta: { color: colors.inkSoft, fontSize: 12, fontWeight: '600', flexShrink: 1 },
  boardActions: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs },
  boardAction: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    height: 28,
    paddingHorizontal: spacing.sm + 2,
    borderRadius: radii.pill,
    backgroundColor: hubColors.pipeline.bg,
  },
  boardActionPrimary: { backgroundColor: hubColors.pipeline.fg },
  boardActionText: { color: hubColors.pipeline.deep, fontSize: 12, fontWeight: '700' },
  boardActionTextPrimary: { color: colors.white },
  boardEmpty: { color: colors.inkSoft, fontSize: 13, fontWeight: '600', textAlign: 'center', padding: spacing.lg },
});
