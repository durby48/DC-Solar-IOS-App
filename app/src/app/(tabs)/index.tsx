import AsyncStorage from '@react-native-async-storage/async-storage';
import { useFocusEffect } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { JobCard } from '@/components/JobCard';
import { colors, radii, shadows, spacing } from '@/constants/theme';
import {
  clockIn,
  clockOut,
  fetchOpenEntry,
  getSessionEmail,
  type TimeEntry,
} from '@/lib/clock';
import { fetchJobs } from '@/lib/data';
import { formatElapsed, formatFullDate, formatShortDate, todayISO } from '@/lib/dates';
import { type Job } from '@/lib/mockData';

const PUNCH_KEY = 'dcsolar.punch';

function greeting(): string {
  const hour = new Date().getHours();
  if (hour < 12) return 'Good morning';
  if (hour < 17) return 'Good afternoon';
  return 'Good evening';
}

export default function TodayScreen() {
  const [clockedInAt, setClockedInAt] = useState<number | null>(null);
  const [now, setNow] = useState(Date.now());
  const [jobs, setJobs] = useState<Job[]>([]);
  const [isMock, setIsMock] = useState(false);
  const [sessionEmail, setSessionEmail] = useState<string | null>(null);
  const [openEntry, setOpenEntry] = useState<TimeEntry | null>(null);
  const [selectedJobId, setSelectedJobId] = useState<string | null>(null);
  const [punchBusy, setPunchBusy] = useState(false);
  const [feedback, setFeedback] = useState<string | null>(null);

  // Restore punch state from storage (local fallback / demo mode).
  useEffect(() => {
    AsyncStorage.getItem(PUNCH_KEY)
      .then((raw) => {
        if (!raw) return;
        const parsed = JSON.parse(raw) as { clockedInAt: number | null };
        if (typeof parsed.clockedInAt === 'number') {
          setClockedInAt(parsed.clockedInAt);
        }
      })
      .catch(() => {});
  }, []);

  // When signed in, the server's open entry is the source of truth.
  useEffect(() => {
    let cancelled = false;
    getSessionEmail().then(async (email) => {
      if (cancelled) return;
      setSessionEmail(email);
      if (!email) return;
      const entry = await fetchOpenEntry(email);
      if (cancelled) return;
      if (entry) {
        setOpenEntry(entry);
        setNow(Date.now());
        // Replace any stale local punch with the server state.
        const startedAt = Date.parse(entry.clock_in);
        setClockedInAt(Number.isNaN(startedAt) ? null : startedAt);
        AsyncStorage.setItem(
          PUNCH_KEY,
          JSON.stringify({ clockedInAt: Number.isNaN(startedAt) ? null : startedAt }),
        ).catch(() => {});
      }
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const clockedIn = openEntry !== null || clockedInAt !== null;
  const clockedInSince =
    openEntry !== null ? Date.parse(openEntry.clock_in) : clockedInAt;

  // Tick elapsed time while clocked in.
  useEffect(() => {
    if (!clockedIn) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [clockedIn]);

  // Brief punch feedback, auto-dismissed.
  useEffect(() => {
    if (feedback === null) return;
    const timer = setTimeout(() => setFeedback(null), 5000);
    return () => clearTimeout(timer);
  }, [feedback]);

  // Refetch the job list on every focus so stage/schedule edits made on
  // other screens show up immediately. Only the jobs list refreshes here —
  // the clock card's state is deliberately left untouched.
  useFocusEffect(
    useCallback(() => {
      let cancelled = false;
      fetchJobs().then(({ jobs: fetched, isMock: mock }) => {
        if (cancelled) return;
        setJobs(fetched);
        setIsMock(mock);
      });
      return () => {
        cancelled = true;
      };
    }, []),
  );

  const setLocalPunch = useCallback((value: number | null) => {
    setClockedInAt(value);
    AsyncStorage.setItem(PUNCH_KEY, JSON.stringify({ clockedInAt: value })).catch(
      () => {},
    );
  }, []);

  const handlePunch = useCallback(async () => {
    if (punchBusy) return;

    // Demo / signed-out mode: local-only punch, as before.
    if (!sessionEmail) {
      const next = clockedInAt === null ? Date.now() : null;
      if (next !== null) setNow(Date.now());
      setLocalPunch(next);
      return;
    }

    setPunchBusy(true);
    try {
      if (openEntry !== null) {
        // Clock out: close the open server entry.
        const result = await clockOut(openEntry);
        setOpenEntry(null);
        setLocalPunch(null);
        setFeedback(
          result.ok
            ? 'Clocked out ✓ synced'
            : 'Clock-out saved on phone — will not sync until you’re online',
        );
      } else if (clockedInAt !== null) {
        // Local punch that never reached the server (offline clock-in).
        setLocalPunch(null);
        setFeedback('Clock-out saved on phone — will not sync until you’re online');
      } else {
        // Clock in: local fallback first, then sync to Supabase.
        const startedAt = Date.now();
        setNow(startedAt);
        setLocalPunch(startedAt);
        const selectedJob = jobs.find((j) => j.id === selectedJobId) ?? null;
        const result = await clockIn({
          email: sessionEmail,
          jobId: selectedJobId,
          jobLabel: selectedJob ? (selectedJob.job_number ?? selectedJob.name) : null,
        });
        if (result.ok) {
          setOpenEntry(result.entry);
          const serverStart = Date.parse(result.entry.clock_in);
          if (!Number.isNaN(serverStart)) setLocalPunch(serverStart);
          setFeedback('Clocked in ✓ synced');
        } else {
          setFeedback('Saved on phone — will not sync until you’re online');
        }
      }
    } finally {
      setPunchBusy(false);
    }
  }, [punchBusy, sessionEmail, openEntry, clockedInAt, jobs, selectedJobId, setLocalPunch]);

  const today = todayISO();
  const todaysJobs = jobs.filter((j) => j.scheduled_for === today);
  const nextJob = jobs
    .filter((j) => j.scheduled_for !== null && j.scheduled_for > today && j.status !== 'completed')
    .sort((a, b) => (a.scheduled_for ?? '').localeCompare(b.scheduled_for ?? ''))[0];

  const showJobChips = sessionEmail !== null && !clockedIn && todaysJobs.length > 0;

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      <ScrollView contentContainerStyle={styles.container}>
        <Text style={styles.greeting}>{greeting()}!</Text>
        <Text style={styles.date}>{formatFullDate(new Date())}</Text>

        <View style={styles.clockCard}>
          <Text style={styles.clockLabel}>
            {clockedIn ? 'On the clock' : 'Off the clock'}
          </Text>
          {clockedIn && clockedInSince !== null && !Number.isNaN(clockedInSince) ? (
            <Text style={styles.elapsed}>
              {formatElapsed(Math.max(0, now - clockedInSince))}
            </Text>
          ) : null}
          {showJobChips ? (
            <View style={styles.chipRow}>
              <Pressable
                onPress={() => setSelectedJobId(null)}
                style={[styles.jobChip, selectedJobId === null && styles.jobChipSelected]}>
                <Text
                  style={[
                    styles.jobChipText,
                    selectedJobId === null && styles.jobChipTextSelected,
                  ]}>
                  No job
                </Text>
              </Pressable>
              {todaysJobs.map((job) => (
                <Pressable
                  key={job.id}
                  onPress={() => setSelectedJobId(job.id)}
                  style={[
                    styles.jobChip,
                    selectedJobId === job.id && styles.jobChipSelected,
                  ]}>
                  <Text
                    style={[
                      styles.jobChipText,
                      selectedJobId === job.id && styles.jobChipTextSelected,
                    ]}>
                    {job.job_number ?? job.name}
                  </Text>
                </Pressable>
              ))}
            </View>
          ) : null}
          <Pressable
            onPress={handlePunch}
            disabled={punchBusy}
            style={({ pressed }) => [
              styles.clockButton,
              clockedIn ? styles.clockButtonIn : styles.clockButtonOut,
              (pressed || punchBusy) && styles.pressed,
            ]}>
            <Text
              style={[
                styles.clockButtonText,
                clockedIn ? styles.clockButtonTextIn : styles.clockButtonTextOut,
              ]}>
              {punchBusy ? 'Punching…' : clockedIn ? 'Clock Out' : 'Clock In'}
            </Text>
          </Pressable>
          <Text style={styles.syncNote}>
            {feedback ??
              (sessionEmail ? 'Syncs to the office' : 'Demo mode — saves to this phone only')}
          </Text>
        </View>

        <Text style={styles.sectionTitle}>Today&apos;s jobs</Text>
        {todaysJobs.length > 0 ? (
          <View style={styles.jobList}>
            {todaysJobs.map((job) => (
              <JobCard key={job.id} job={job} subtitle="Today" />
            ))}
          </View>
        ) : (
          <View style={styles.emptyCard}>
            <Text style={styles.emptyText}>No jobs scheduled for today.</Text>
          </View>
        )}

        {nextJob ? (
          <>
            <Text style={styles.sectionTitle}>Up next</Text>
            <JobCard job={nextJob} subtitle={formatShortDate(nextJob.scheduled_for)} />
          </>
        ) : null}

        {isMock ? <Text style={styles.mockNote}>Showing demo data</Text> : null}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: {
    flex: 1,
    backgroundColor: colors.cream,
  },
  container: {
    padding: spacing.lg,
    gap: spacing.sm,
    paddingBottom: spacing.xl,
  },
  greeting: {
    color: colors.ink,
    fontSize: 28,
    fontWeight: '800',
  },
  date: {
    color: colors.inkSoft,
    fontSize: 16,
    marginBottom: spacing.sm,
  },
  clockCard: {
    backgroundColor: colors.white,
    borderRadius: radii.lg,
    padding: spacing.lg,
    alignItems: 'center',
    gap: spacing.sm,
    marginBottom: spacing.md,
    ...shadows.card,
  },
  clockLabel: {
    color: colors.inkSoft,
    fontSize: 15,
    fontWeight: '600',
  },
  elapsed: {
    color: colors.ink,
    fontSize: 40,
    fontWeight: '800',
    fontVariant: ['tabular-nums'],
  },
  chipRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'center',
    gap: spacing.sm,
    alignSelf: 'stretch',
  },
  jobChip: {
    borderRadius: radii.pill,
    paddingHorizontal: spacing.sm + 2,
    paddingVertical: spacing.xs,
    backgroundColor: colors.white,
    borderWidth: 1,
    borderColor: colors.tan,
  },
  jobChipSelected: {
    backgroundColor: colors.skySoft,
    borderColor: colors.skySoft,
  },
  jobChipText: {
    color: colors.inkSoft,
    fontSize: 12,
    fontWeight: '700',
  },
  jobChipTextSelected: {
    color: colors.ocean,
    fontWeight: '800',
  },
  clockButton: {
    borderRadius: radii.lg,
    paddingVertical: spacing.lg,
    alignItems: 'center',
    alignSelf: 'stretch',
    ...shadows.card,
  },
  clockButtonOut: {
    backgroundColor: colors.sun,
  },
  clockButtonIn: {
    backgroundColor: colors.ink,
  },
  clockButtonText: {
    fontSize: 22,
    fontWeight: '800',
  },
  clockButtonTextOut: {
    color: colors.ink,
  },
  clockButtonTextIn: {
    color: colors.cream,
  },
  pressed: {
    opacity: 0.85,
  },
  syncNote: {
    color: colors.inkSoft,
    fontSize: 12,
    textAlign: 'center',
  },
  sectionTitle: {
    color: colors.ink,
    fontSize: 18,
    fontWeight: '700',
    marginTop: spacing.md,
  },
  jobList: {
    gap: spacing.md,
  },
  emptyCard: {
    backgroundColor: colors.skySoft,
    borderRadius: radii.md,
    padding: spacing.md,
  },
  emptyText: {
    color: colors.inkSoft,
    fontSize: 14,
  },
  mockNote: {
    color: colors.inkSoft,
    fontSize: 12,
    textAlign: 'center',
    marginTop: spacing.md,
  },
});
