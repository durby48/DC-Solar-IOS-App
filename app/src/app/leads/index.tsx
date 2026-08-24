import Ionicons from '@expo/vector-icons/Ionicons';
import { Stack, useFocusEffect, useRouter } from 'expo-router';
import { useCallback, useMemo, useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { Field } from '@/components/forms/Field';
import {
  AnimatedPressable,
  AppText,
  Button,
  Card,
  EmptyState,
  FadeInUp,
  Pill,
  Screen,
  SectionHeader,
  SkeletonList,
} from '@/components/ui';
import { colors, radii, spacing } from '@/constants/theme';
import { createLead } from '@/lib/leads';
import { fetchOpenLeads, type Lead, type LeadStatus } from '@/lib/sales';
import * as haptics from '@/lib/haptics';
import { useRole } from '@/lib/role';

/**
 * The SALES pipeline — leads only, deliberately separate from the project
 * Pipeline tab. Nothing here has financial weight: no estimates, no
 * finance entries, no rollups. Leads get PROJECTIONS (pre-estimates); real
 * money starts when a lead converts into a customer + project.
 */

export const LEAD_STATUS_LABELS: Record<LeadStatus, string> = {
  new: 'New',
  contacted: 'Contacted',
  estimating: 'Projection',
  won: 'Won',
  lost: 'Lost',
};

export const LEAD_STATUS_ORDER: LeadStatus[] = ['new', 'contacted', 'estimating', 'won', 'lost'];

export function leadStatusTone(status: LeadStatus): { bg: string; fg: string } {
  if (status === 'won') return { bg: colors.mintSoft, fg: colors.mintDeep };
  if (status === 'lost') return { bg: colors.coralSoft, fg: colors.coralDeep };
  if (status === 'estimating') return { bg: colors.amberSoft, fg: colors.amber };
  if (status === 'contacted') return { bg: colors.tealSoft, fg: colors.teal };
  return { bg: colors.skySoft, fg: colors.ocean };
}

export default function LeadsScreen() {
  const router = useRouter();
  const role = useRole();

  const [leads, setLeads] = useState<Lead[] | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  // New-lead form.
  const [formOpen, setFormOpen] = useState(false);
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [leadEmail, setLeadEmail] = useState('');
  const [address, setAddress] = useState('');
  const [source, setSource] = useState('');
  const [value, setValue] = useState('');
  const [notes, setNotes] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLeads(await fetchOpenLeads());
    setLoaded(true);
  }, []);

  useFocusEffect(
    useCallback(() => {
      load();
    }, [load]),
  );

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    try {
      await load();
    } finally {
      setRefreshing(false);
    }
  }, [load]);

  const groups = useMemo(() => {
    const byStatus = new Map<LeadStatus, Lead[]>();
    for (const lead of leads ?? []) {
      const key = (LEAD_STATUS_ORDER.includes(lead.status) ? lead.status : 'new') as LeadStatus;
      byStatus.set(key, [...(byStatus.get(key) ?? []), lead]);
    }
    return LEAD_STATUS_ORDER.map((status) => ({
      status,
      leads: byStatus.get(status) ?? [],
    })).filter((g) => g.leads.length > 0);
  }, [leads]);

  const resetForm = () => {
    setName('');
    setPhone('');
    setLeadEmail('');
    setAddress('');
    setSource('');
    setValue('');
    setNotes('');
  };

  const save = async () => {
    if (!name.trim()) {
      setError('A lead needs at least a name.');
      return;
    }
    const estValue = value.trim() ? Number(value.replace(/[^0-9.]/g, '')) : null;
    if (estValue !== null && !Number.isFinite(estValue)) {
      setError('The potential value should be a number.');
      return;
    }
    setSaving(true);
    setError(null);
    const result = await createLead(
      {
        name,
        phone,
        email: leadEmail,
        address,
        source,
        estimated_value: estValue,
        notes,
      },
      role?.email ?? null,
    );
    setSaving(false);
    if (result.ok) {
      haptics.success();
      resetForm();
      setFormOpen(false);
      await load();
      // Cast until the dev server regenerates typed routes for /leads.
      router.push({ pathname: '/leads/[id]', params: { id: result.id } } as never);
    } else {
      setError(result.message);
    }
  };

  return (
    <>
      <Stack.Screen options={{ title: 'Sales Pipeline' }} />
      <Screen edges={[]} refreshing={refreshing} onRefresh={onRefresh}>
        <View style={styles.headerRow}>
          <AppText variant="caption" color={colors.textMuted} style={styles.blurb}>
            Leads only — nothing here touches the financials. Projections are pre-estimates;
            money starts when a lead becomes a customer with a project.
          </AppText>
          <Button
            label={formOpen ? 'Close' : '+ New lead'}
            size="sm"
            variant={formOpen ? 'secondary' : 'primary'}
            onPress={() => {
              setError(null);
              setFormOpen((open) => !open);
            }}
          />
        </View>

        {formOpen ? (
          <Card style={styles.formCard}>
            <Field label="Name *" value={name} onChangeText={setName} placeholder="Jane Doe" />
            <Field
              label="Phone"
              value={phone}
              onChangeText={setPhone}
              placeholder="(816) 555-0100"
              keyboardType="phone-pad"
            />
            <Field
              label="Email"
              value={leadEmail}
              onChangeText={setLeadEmail}
              placeholder="name@example.com"
              autoCapitalize="none"
              keyboardType="email-address"
            />
            <Field
              label="Address"
              value={address}
              onChangeText={setAddress}
              placeholder="Street, city"
            />
            <Field
              label="Source"
              value={source}
              onChangeText={setSource}
              placeholder="Referral, Google, door knock…"
            />
            <Field
              label="Potential value ($, optional)"
              value={value}
              onChangeText={setValue}
              placeholder="0"
              keyboardType="decimal-pad"
            />
            <Field label="Notes" value={notes} onChangeText={setNotes} placeholder="Anything useful" />
            {error ? (
              <AppText variant="caption" color={colors.danger}>
                {error}
              </AppText>
            ) : null}
            <Button
              label="Create lead"
              icon="person-add"
              onPress={() => void save()}
              loading={saving}
              disabled={saving}
              fullWidth
            />
          </Card>
        ) : null}

        {!loaded ? (
          <SkeletonList count={4} height={84} />
        ) : !role ? null : groups.length === 0 ? (
          <Card>
            <EmptyState
              icon="person-add"
              title="No leads yet."
              body="Create one above — it lives in the sales pipeline until you convert it."
            />
          </Card>
        ) : (
          groups.map((group) => (
            <View key={group.status} style={styles.group}>
              <SectionHeader
                title={LEAD_STATUS_LABELS[group.status]}
                subtitle={`${group.leads.length} ${group.leads.length === 1 ? 'lead' : 'leads'}`}
              />
              <Card padded={false}>
                {group.leads.map((lead, index) => {
                  const tone = leadStatusTone(group.status);
                  return (
                    <FadeInUp key={lead.id} index={index}>
                      <AnimatedPressable
                        onPress={() =>
                          router.push({ pathname: '/leads/[id]', params: { id: lead.id } } as never)
                        }
                        haptic="tapLight"
                        scaleTo={0.995}
                        accessibilityRole="button"
                        accessibilityLabel={lead.name}
                        style={[styles.leadRow, index > 0 && styles.rowBorderTop]}>
                        <View style={styles.leadBody}>
                          <AppText variant="bodyStrong" numberOfLines={1}>
                            {lead.name}
                          </AppText>
                          <AppText variant="caption" color={colors.textMuted} numberOfLines={1}>
                            {[
                              lead.address,
                              lead.source ? `via ${lead.source}` : null,
                              lead.assigned_to,
                            ]
                              .filter(Boolean)
                              .join(' · ') || 'no details yet'}
                          </AppText>
                        </View>
                        {lead.estimated_value !== null ? (
                          <Pill label={`$${Number(lead.estimated_value).toLocaleString('en-US')}`} bg={tone.bg} fg={tone.fg} />
                        ) : null}
                        <Ionicons name="chevron-forward" size={16} color={colors.textMuted} />
                      </AnimatedPressable>
                    </FadeInUp>
                  );
                })}
              </Card>
            </View>
          ))
        )}
      </Screen>
    </>
  );
}

const styles = StyleSheet.create({
  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    marginBottom: spacing.sm,
  },
  blurb: {
    flex: 1,
  },
  formCard: {
    marginBottom: spacing.md,
    gap: 2,
  },
  group: {
    marginBottom: spacing.md,
  },
  leadRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    padding: spacing.md,
    backgroundColor: colors.surface,
    borderRadius: radii.md,
  },
  rowBorderTop: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
    borderTopLeftRadius: 0,
    borderTopRightRadius: 0,
  },
  leadBody: {
    flex: 1,
    gap: 2,
  },
});
