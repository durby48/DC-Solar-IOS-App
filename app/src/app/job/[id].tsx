import Ionicons from '@expo/vector-icons/Ionicons';
import { Stack, router, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Linking,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';

import { CustomerCard } from '@/components/CustomerCard';
import { JobAssignedCrew } from '@/components/JobAssignedCrew';
import { JobDocuments } from '@/components/JobDocuments';
import { JobFinanceHeader } from '@/components/JobFinanceHeader';
import { JobInvoices } from '@/components/JobInvoices';
import { JobArtwork } from '@/components/JobArtwork';
import { JobMaterials } from '@/components/JobMaterials';
import { JobMyHours } from '@/components/JobMyHours';
import { JobPhotos } from '@/components/JobPhotos';
import { JobScheduleDates } from '@/components/JobScheduleDates';
import { StatusPill } from '@/components/StatusPill';
import { colors, radii, shadows, spacing } from '@/constants/theme';
import { fetchJob } from '@/lib/data';
import { formatShortDate } from '@/lib/dates';
import { fetchMyJobHours, type JobWithPM } from '@/lib/jobs';
import { useRole } from '@/lib/role';
import { stageOrDefault } from '@/lib/stages';

export default function JobDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const [job, setJob] = useState<JobWithPM | null>(null);
  const [loading, setLoading] = useState(true);
  const [myHours, setMyHours] = useState(0);
  // Bumped when JobInvoices edits/deletes an entry so the finance header
  // (which fetches independently) refreshes its totals too.
  const [financeRefresh, setFinanceRefresh] = useState(0);
  // Bumped when the user logs/edits own hours so the hours card refreshes.
  const [hoursRefresh, setHoursRefresh] = useState(0);
  const role = useRole();

  // Refetch on every focus so edits made in the job editor show immediately.
  useFocusEffect(
    useCallback(() => {
      let cancelled = false;
      if (!id) {
        setLoading(false);
        return;
      }
      fetchJob(id).then((result) => {
        if (cancelled) return;
        setJob(result);
        setLoading(false);
      });
      return () => {
        cancelled = true;
      };
    }, [id]),
  );

  const isCrewMember = role != null && !role.isAdmin;
  const crewDisplayName = isCrewMember ? role.displayName : null;
  const crewEmail = isCrewMember ? role.email : null;

  useEffect(() => {
    let cancelled = false;
    if (!id || !crewEmail) {
      setMyHours(0);
      return;
    }
    // hoursRefresh re-runs this after the user logs/edits hours below.
    void hoursRefresh;
    fetchMyJobHours({ jobId: id, displayName: crewDisplayName, email: crewEmail }).then(
      (hours) => {
        if (!cancelled) setMyHours(hours);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [id, crewDisplayName, crewEmail, hoursRefresh]);

  const openMaps = (address: string) => {
    Linking.openURL('https://maps.apple.com/?daddr=' + encodeURIComponent(address)).catch(
      () => {},
    );
  };


  return (
    <>
      <Stack.Screen options={{ title: job?.job_number ?? 'Job' }} />
      <ScrollView style={styles.safe} contentContainerStyle={styles.container}>
        {loading ? (
          <ActivityIndicator color={colors.ocean} style={styles.loader} />
        ) : !job ? (
          <Text style={styles.notFound}>Job not found.</Text>
        ) : (
          <>
            {role?.isAdmin ? (
              <JobFinanceHeader jobId={job.id} refreshKey={financeRefresh} />
            ) : null}

            {role?.isAdmin ? (
              <JobInvoices
                job={job}
                onEntriesChanged={() => setFinanceRefresh((k) => k + 1)}
              />
            ) : null}

            <View style={styles.headerCard}>
              <View style={styles.topRow}>
                {job.job_number ? (
                  <Text style={styles.jobNumber}>{job.job_number}</Text>
                ) : null}
                <StatusPill stage={stageOrDefault(job.stage, job.status)} />
              </View>
              <View style={styles.nameRow}>
                <Text style={styles.name}>{job.name}</Text>
                {role?.isAdmin ? (
                  <Pressable
                    onPress={() =>
                      router.push({ pathname: '/job-editor', params: { jobId: job.id } })
                    }
                    hitSlop={8}
                    style={({ pressed }) => [styles.editButton, pressed && styles.editPressed]}>
                    <Ionicons name="pencil" size={16} color={colors.ocean} />
                    <Text style={styles.editButtonText}>Edit</Text>
                  </Pressable>
                ) : null}
              </View>
              <Text style={styles.date}>
                {formatShortDate(job.scheduled_for)}
                {job.scheduled_end ? ` — ${formatShortDate(job.scheduled_end)}` : ''}
              </Text>
              {job.description ? (
                <Text style={styles.description}>{job.description}</Text>
              ) : null}
            </View>

            {job.address ? (
              <View style={styles.card}>
                <Pressable
                  onPress={() => openMaps(job.address as string)}
                  style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}>
                  <View style={styles.iconWrap}>
                    <Ionicons name="navigate" size={18} color={colors.ocean} />
                  </View>
                  <View style={styles.rowBody}>
                    <Text style={styles.rowLabel}>Directions</Text>
                    <Text style={styles.rowValue}>{job.address}</Text>
                  </View>
                  <Ionicons name="chevron-forward" size={18} color={colors.inkSoft} />
                </Pressable>
              </View>
            ) : null}

            {job.project_manager ? (
              <View style={styles.card}>
                {job.project_manager_phone ? (
                  <Pressable
                    onPress={() =>
                      Linking.openURL(
                        'tel:' + (job.project_manager_phone as string).replace(/[^+\d]/g, ''),
                      ).catch(() => {})
                    }
                    style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}>
                    <View style={styles.iconWrap}>
                      <Ionicons name="person-circle" size={18} color={colors.ocean} />
                    </View>
                    <View style={styles.rowBody}>
                      <Text style={styles.rowLabel}>Project manager</Text>
                      <Text style={styles.rowValue}>{job.project_manager}</Text>
                      <Text style={styles.rowPhone}>{job.project_manager_phone}</Text>
                    </View>
                    <Ionicons name="call" size={18} color={colors.ocean} />
                  </Pressable>
                ) : (
                  <View style={styles.row}>
                    <View style={styles.iconWrap}>
                      <Ionicons name="person-circle" size={18} color={colors.ocean} />
                    </View>
                    <View style={styles.rowBody}>
                      <Text style={styles.rowLabel}>Project manager</Text>
                      <Text style={styles.rowValue}>{job.project_manager}</Text>
                    </View>
                  </View>
                )}
              </View>
            ) : null}

            {isCrewMember && myHours > 0 ? (
              <View style={styles.hoursCard}>
                <View style={styles.iconWrap}>
                  <Ionicons name="time" size={18} color={colors.ocean} />
                </View>
                <View style={styles.rowBody}>
                  <Text style={styles.rowLabel}>Your hours on this job</Text>
                  <Text style={styles.hoursValue}>{myHours.toFixed(1)} h</Text>
                </View>
              </View>
            ) : null}

            {job.customer ? <CustomerCard customer={job.customer} /> : null}

            <JobScheduleDates jobId={job.id} isAdmin={role?.isAdmin ?? false} />

            {role ? (
              <JobAssignedCrew jobId={job.id} isAdmin={role.isAdmin} />
            ) : null}

            {role ? (
              <JobMyHours
                jobId={job.id}
                email={role.email}
                isAdmin={role.isAdmin}
                onChanged={() => setHoursRefresh((n) => n + 1)}
              />
            ) : null}

            <JobDocuments jobId={job.id} />

            <JobPhotos jobId={job.id} />

            <JobMaterials jobId={job.id} isAdmin={role?.isAdmin ?? false} />

            {role?.isAdmin ? <JobArtwork job={job} /> : null}
          </>
        )}
      </ScrollView>
    </>
  );
}

const styles = StyleSheet.create({
  safe: {
    flex: 1,
    backgroundColor: colors.cream,
  },
  container: {
    padding: spacing.lg,
    paddingBottom: spacing.xl,
    gap: spacing.md,
  },
  loader: {
    marginTop: spacing.xl,
  },
  notFound: {
    color: colors.inkSoft,
    fontSize: 16,
    textAlign: 'center',
    marginTop: spacing.xl,
  },
  headerCard: {
    backgroundColor: colors.white,
    borderRadius: radii.md,
    padding: spacing.md,
    gap: spacing.xs,
    ...shadows.card,
  },
  topRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  jobNumber: {
    color: colors.ocean,
    fontSize: 14,
    fontWeight: '800',
  },
  nameRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.sm,
  },
  name: {
    flex: 1,
    color: colors.ink,
    fontSize: 22,
    fontWeight: '800',
  },
  editButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    backgroundColor: colors.skySoft,
    borderRadius: radii.pill,
    paddingVertical: spacing.xs + 2,
    paddingHorizontal: spacing.sm + 4,
  },
  editPressed: {
    opacity: 0.6,
  },
  editButtonText: {
    color: colors.ocean,
    fontSize: 13,
    fontWeight: '800',
  },
  date: {
    color: colors.inkSoft,
    fontSize: 15,
    fontWeight: '600',
  },
  description: {
    color: colors.inkSoft,
    fontSize: 14,
    marginTop: spacing.xs,
  },
  card: {
    backgroundColor: colors.white,
    borderRadius: radii.md,
    overflow: 'hidden',
    ...shadows.card,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    padding: spacing.md,
  },
  rowPressed: {
    backgroundColor: colors.skySoft,
  },
  iconWrap: {
    width: 32,
    height: 32,
    borderRadius: radii.sm,
    backgroundColor: colors.skySoft,
    alignItems: 'center',
    justifyContent: 'center',
  },
  rowBody: {
    flex: 1,
    gap: 2,
  },
  rowLabel: {
    color: colors.inkSoft,
    fontSize: 12,
    fontWeight: '700',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  rowValue: {
    color: colors.ink,
    fontSize: 15,
    fontWeight: '600',
  },
  rowPhone: {
    color: colors.ocean,
    fontSize: 14,
    fontWeight: '700',
  },
  hoursCard: {
    backgroundColor: colors.white,
    borderRadius: radii.md,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    padding: spacing.md,
    ...shadows.card,
  },
  hoursValue: {
    color: colors.ink,
    fontSize: 20,
    fontWeight: '800',
  },
  sectionTitle: {
    color: colors.ink,
    fontSize: 18,
    fontWeight: '700',
    marginTop: spacing.sm,
  },
  placeholderCard: {
    backgroundColor: colors.skySoft,
    borderRadius: radii.md,
    padding: spacing.lg,
    alignItems: 'center',
    gap: spacing.xs,
  },
  placeholderText: {
    color: colors.inkSoft,
    fontSize: 14,
    fontWeight: '600',
  },
});
