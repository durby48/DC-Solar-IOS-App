import Ionicons from '@expo/vector-icons/Ionicons';
import { Stack } from 'expo-router';
import { useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';

import { colors, radii, shadows, spacing } from '@/constants/theme';
import { getRole, type EmployeeRole, type RoleInfo } from '@/lib/role';
import { supabase } from '@/lib/supabase';

interface EmployeeRow {
  id: string;
  email: string;
  display_name: string | null;
  role: EmployeeRole;
  pay_rate: number | null;
}

const ROLE_META: Record<EmployeeRole, { label: string; bg: string; text: string }> = {
  owner: { bg: colors.sunLight, text: colors.ink, label: 'Owner' },
  operator: { bg: colors.skySoft, text: colors.ocean, label: 'Operator' },
  viewer: { bg: colors.tan, text: colors.inkSoft, label: 'Viewer' },
};

const PLACEHOLDER_SECTIONS: { icon: keyof typeof Ionicons.glyphMap; title: string }[] = [
  { icon: 'cash', title: 'Pay history' },
  { icon: 'document-text', title: 'Tax documents (W-4/W-2)' },
  { icon: 'briefcase', title: 'Employment details' },
];

function formatPayRate(rate: number | null): string | null {
  if (rate == null || !Number.isFinite(rate)) return null;
  const rounded = Number.isInteger(rate) ? `${rate}` : rate.toFixed(2);
  return `$${rounded}/hr`;
}

/**
 * Auth + role with an explicit loading phase (useRole alone can't distinguish
 * "still loading" from "signed out / not an admin").
 */
function useGate(): { state: 'loading' | 'out' | 'in'; role: RoleInfo | null } {
  const [state, setState] = useState<'loading' | 'out' | 'in'>('loading');
  const [role, setRole] = useState<RoleInfo | null>(null);
  useEffect(() => {
    let cancelled = false;
    const resolve = async () => {
      const { data } = await supabase.auth.getSession();
      const email = data.session?.user?.email ?? null;
      if (cancelled) return;
      if (!email) {
        setRole(null);
        setState('out');
        return;
      }
      const info = await getRole();
      if (cancelled) return;
      setRole(info);
      setState('in');
    };
    resolve();
    const { data: sub } = supabase.auth.onAuthStateChange(() => {
      if (!cancelled) resolve();
    });
    return () => {
      cancelled = true;
      sub.subscription.unsubscribe();
    };
  }, []);
  return { state, role };
}

export default function EmployeesScreen() {
  const gate = useGate();
  const isAdmin = gate.role?.isAdmin ?? false;

  const [listState, setListState] = useState<'loading' | 'ok' | 'unavailable'>('loading');
  const [employees, setEmployees] = useState<EmployeeRow[]>([]);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  useEffect(() => {
    if (gate.state !== 'in' || !isAdmin) return;
    let cancelled = false;
    const load = async () => {
      try {
        const { data, error } = await supabase
          .from('employees')
          .select('id, email, display_name, role, pay_rate')
          .order('display_name', { ascending: true });
        if (cancelled) return;
        if (error || !data) {
          setListState('unavailable');
          return;
        }
        setEmployees(
          data.map((row) => ({
            id: String(row.id),
            email: row.email as string,
            display_name: (row.display_name as string | null) ?? null,
            role: row.role as EmployeeRole,
            pay_rate: row.pay_rate != null ? Number(row.pay_rate) : null,
          })),
        );
        setListState('ok');
      } catch {
        if (!cancelled) setListState('unavailable');
      }
    };
    load();
    return () => {
      cancelled = true;
    };
  }, [gate.state, isAdmin]);

  const renderEmployee = (employee: EmployeeRow) => {
    const meta = ROLE_META[employee.role] ?? ROLE_META.viewer;
    const pay = formatPayRate(employee.pay_rate);
    const expanded = expandedId === employee.id;
    return (
      <View key={employee.id} style={styles.employeeCard}>
        <Pressable
          onPress={() => setExpandedId((prev) => (prev === employee.id ? null : employee.id))}
          style={({ pressed }) => [styles.employeeRow, pressed && styles.rowPressed]}>
          <View style={styles.iconWrap}>
            <Ionicons name="person" size={18} color={colors.ocean} />
          </View>
          <View style={styles.employeeBody}>
            <Text style={styles.employeeName}>{employee.display_name ?? employee.email}</Text>
            <Text style={styles.employeeEmail}>{employee.email}</Text>
          </View>
          <View style={styles.metaColumn}>
            <View style={[styles.roleChip, { backgroundColor: meta.bg }]}>
              <Text style={[styles.roleChipText, { color: meta.text }]}>{meta.label}</Text>
            </View>
            {pay ? <Text style={styles.payText}>{pay}</Text> : null}
          </View>
          <Ionicons
            name={expanded ? 'chevron-up' : 'chevron-down'}
            size={16}
            color={colors.inkSoft}
          />
        </Pressable>
        {expanded ? (
          <View style={styles.expandArea}>
            {PLACEHOLDER_SECTIONS.map((section) => (
              <View key={section.title} style={styles.placeholderCard}>
                <View style={styles.placeholderHeader}>
                  <Ionicons name={section.icon} size={16} color={colors.ocean} />
                  <Text style={styles.placeholderTitle}>{section.title}</Text>
                </View>
                <View style={styles.comingSoonPill}>
                  <Text style={styles.comingSoonText}>Coming soon</Text>
                </View>
              </View>
            ))}
          </View>
        ) : null}
      </View>
    );
  };

  return (
    <>
      <Stack.Screen options={{ title: 'Employees' }} />
      <ScrollView style={styles.screen} contentContainerStyle={styles.container}>
        {gate.state === 'loading' ? (
          <View style={styles.centerCard}>
            <ActivityIndicator color={colors.ocean} />
          </View>
        ) : gate.state === 'out' ? (
          <View style={styles.centerCard}>
            <View style={styles.badge}>
              <Ionicons name="id-card" size={26} color={colors.ocean} />
            </View>
            <Text style={styles.promptTitle}>Sign in to view employees</Text>
            <Text style={styles.promptText}>
              The employee dashboard is only visible to signed-in admins.
            </Text>
          </View>
        ) : !isAdmin ? (
          <View style={styles.centerCard}>
            <View style={styles.badge}>
              <Ionicons name="lock-closed" size={26} color={colors.ocean} />
            </View>
            <Text style={styles.promptTitle}>Admins only</Text>
            <Text style={styles.promptText}>
              The employee dashboard is limited to owners and operators.
            </Text>
          </View>
        ) : (
          <>
            <View style={styles.noteCard}>
              <Ionicons name="information-circle" size={18} color={colors.ocean} />
              <Text style={styles.noteText}>
                Payroll data will appear here after the Gusto migration.
              </Text>
            </View>

            <Text style={styles.sectionTitle}>Team</Text>
            {listState === 'loading' ? (
              <View style={styles.centerCard}>
                <ActivityIndicator color={colors.ocean} />
              </View>
            ) : listState === 'unavailable' ? (
              <View style={styles.centerCard}>
                <Text style={styles.promptText}>Employees are unavailable right now.</Text>
              </View>
            ) : employees.length === 0 ? (
              <View style={styles.centerCard}>
                <Ionicons name="id-card" size={22} color={colors.inkSoft} />
                <Text style={styles.promptText}>No employees yet</Text>
              </View>
            ) : (
              employees.map(renderEmployee)
            )}
          </>
        )}
      </ScrollView>
    </>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: colors.cream,
  },
  container: {
    padding: spacing.lg,
    gap: spacing.md,
    paddingBottom: spacing.xxl,
  },
  sectionTitle: {
    color: colors.ink,
    fontSize: 18,
    fontWeight: '700',
    marginTop: spacing.sm,
  },
  centerCard: {
    backgroundColor: colors.skySoft,
    borderRadius: radii.md,
    padding: spacing.lg,
    alignItems: 'center',
    gap: spacing.sm,
  },
  badge: {
    width: 56,
    height: 56,
    borderRadius: radii.lg,
    backgroundColor: colors.white,
    alignItems: 'center',
    justifyContent: 'center',
  },
  promptTitle: {
    color: colors.ink,
    fontSize: 17,
    fontWeight: '800',
    textAlign: 'center',
  },
  promptText: {
    color: colors.inkSoft,
    fontSize: 14,
    fontWeight: '600',
    textAlign: 'center',
  },
  noteCard: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    backgroundColor: colors.skySoft,
    borderRadius: radii.md,
    padding: spacing.md,
  },
  noteText: {
    flex: 1,
    color: colors.inkSoft,
    fontSize: 13,
    fontWeight: '600',
  },
  employeeCard: {
    backgroundColor: colors.white,
    borderRadius: radii.md,
    overflow: 'hidden',
    ...shadows.card,
  },
  employeeRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
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
  employeeBody: {
    flex: 1,
    gap: 2,
  },
  employeeName: {
    color: colors.ink,
    fontSize: 15,
    fontWeight: '700',
  },
  employeeEmail: {
    color: colors.inkSoft,
    fontSize: 12,
    fontWeight: '600',
  },
  metaColumn: {
    alignItems: 'flex-end',
    gap: 4,
  },
  roleChip: {
    borderRadius: radii.pill,
    paddingHorizontal: spacing.sm,
    paddingVertical: 3,
  },
  roleChipText: {
    fontSize: 11,
    fontWeight: '800',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  payText: {
    color: colors.ocean,
    fontSize: 13,
    fontWeight: '800',
  },
  expandArea: {
    paddingHorizontal: spacing.md,
    paddingBottom: spacing.md,
    gap: spacing.sm,
  },
  placeholderCard: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.sm,
    backgroundColor: colors.skySoft,
    borderRadius: radii.sm,
    padding: spacing.md,
  },
  placeholderHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    flexShrink: 1,
  },
  placeholderTitle: {
    color: colors.ink,
    fontSize: 14,
    fontWeight: '700',
    flexShrink: 1,
  },
  comingSoonPill: {
    borderRadius: radii.pill,
    backgroundColor: colors.white,
    paddingHorizontal: spacing.sm,
    paddingVertical: 3,
  },
  comingSoonText: {
    color: colors.inkSoft,
    fontSize: 11,
    fontWeight: '800',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
});
