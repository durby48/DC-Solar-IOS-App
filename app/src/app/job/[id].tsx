import Ionicons from '@expo/vector-icons/Ionicons';
import { Stack, router, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { Linking, ScrollView, StyleSheet, View } from 'react-native';

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
import {
  AppText,
  Button,
  Card,
  Chip,
  EmptyState,
  ListRow,
  SkeletonList,
} from '@/components/ui';
import { colors, radii, spacing } from '@/constants/theme';
import { fetchJob } from '@/lib/data';
import { formatShortDate } from '@/lib/dates';
import { fetchMyJobHours, type JobWithPM } from '@/lib/jobs';
import { useRole } from '@/lib/role';
import { stageOrDefault } from '@/lib/stages';

/**
 * One job, everything about it, in the order the crew and the office read it:
 * money first for admins, then who/where/when, then the sections each own
 * their own card.
 *
 * 2026-08-22 restyle: the local card/row/chip styles are gone in favour of
 * `Card`, `ListRow`, `Chip` and `Button`; the first-load spinner became a
 * `SkeletonList` and "Job not found." an `EmptyState`. Every role gate and
 * every child component call is byte-for-byte what it was.
 *
 * There is deliberately no stage picker on this screen — the stage is set in
 * `job-editor.tsx`, which is where the "job → Complete" confetti belongs.
 */
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
          <SkeletonList count={4} height={96} />
        ) : !job ? (
          <EmptyState
            icon="help-circle"
            title="Job not found"
            body="It may have been deleted, or you may not have access to it. Go back and pick another job."
          />
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

            <Card style={styles.headerCard}>
              <View style={styles.topRow}>
                {job.job_number ? <Chip label={job.job_number} tone="olive" /> : null}
                <StatusPill stage={stageOrDefault(job.stage, job.status)} />
              </View>
              <View style={styles.nameRow}>
                <AppText variant="title" style={styles.name}>
                  {job.name}
                </AppText>
                {role?.isAdmin ? (
                  <Button
                    label="Edit"
                    onPress={() =>
                      router.push({ pathname: '/job-editor', params: { jobId: job.id } })
                    }
                    variant="secondary"
                    size="sm"
                    icon="pencil"
                  />
                ) : null}
              </View>
              <AppText variant="body" color={colors.textSecondary}>
                {formatShortDate(job.scheduled_for)}
                {job.scheduled_end ? ` — ${formatShortDate(job.scheduled_end)}` : ''}
              </AppText>
              {job.description ? (
                <AppText variant="body" color={colors.textMuted} style={styles.description}>
                  {job.description}
                </AppText>
              ) : null}
            </Card>

            {job.address ? (
              <Card padded={false}>
                <ListRow
                  icon="navigate"
                  title={job.address}
                  subtitle="Directions"
                  onPress={() => openMaps(job.address as string)}
                />
              </Card>
            ) : null}

            {job.project_manager ? (
              <Card padded={false}>
                <ListRow
                  icon="person-circle"
                  title={job.project_manager}
                  subtitle={
                    job.project_manager_phone
                      ? `Project manager · ${job.project_manager_phone}`
                      : 'Project manager'
                  }
                  onPress={
                    job.project_manager_phone
                      ? () =>
                          Linking.openURL(
                            'tel:' + (job.project_manager_phone as string).replace(/[^+\d]/g, ''),
                          ).catch(() => {})
                      : undefined
                  }
                  chevron={false}
                  right={
                    job.project_manager_phone ? (
                      <Ionicons name="call" size={18} color={colors.accentPrimary} />
                    ) : undefined
                  }
                />
              </Card>
            ) : null}

            {isCrewMember && myHours > 0 ? (
              <Card style={styles.hoursCard}>
                <View style={styles.iconWrap}>
                  <Ionicons name="time" size={18} color={colors.accentPrimary} />
                </View>
                <View style={styles.rowBody}>
                  <AppText variant="section" color={colors.accentPrimary}>
                    Your hours on this job
                  </AppText>
                  <AppText variant="numeric">{myHours.toFixed(1)} h</AppText>
                </View>
              </Card>
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
    backgroundColor: colors.surfaceAlt,
  },
  container: {
    padding: spacing.lg,
    paddingBottom: spacing.xl,
    gap: spacing.md,
  },
  headerCard: {
    gap: spacing.xs,
  },
  topRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  nameRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.sm,
  },
  name: {
    flex: 1,
  },
  description: {
    marginTop: spacing.xs,
  },
  hoursCard: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
  },
  iconWrap: {
    width: 32,
    height: 32,
    borderRadius: radii.sm,
    backgroundColor: colors.oliveSoft,
    alignItems: 'center',
    justifyContent: 'center',
  },
  rowBody: {
    flex: 1,
    gap: 2,
  },
});
