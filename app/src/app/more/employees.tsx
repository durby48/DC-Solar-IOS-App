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

import { EmptyState } from '@/components/ui';
import { colors, radii, shadows, spacing } from '@/constants/theme';
import { fetchPaystubs, type EmployeeDocument } from '@/lib/paystubs';
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

/** What the expanded row shows for one employee's documents. */
type DocsState =
  | { status: 'loading' }
  | { status: 'ok'; paystubs: EmployeeDocument[] }
  | { status: 'unavailable' };

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
  /** Paystub rows per employee, fetched the first time a row is expanded. */
  const [docs, setDocs] = useState<Map<string, DocsState>>(new Map());

  /**
   * Load one employee's paystubs on demand. Admins read the whole company
   * under RLS, so this is scoped by employee_id rather than filtered here.
   */
  useEffect(() => {
    const id = expandedId;
    if (!id || docs.has(id)) return;
    let cancelled = false;
    setDocs((prev) => new Map(prev).set(id, { status: 'loading' }));
    fetchPaystubs(id).then((result) => {
      if (cancelled) return;
      setDocs((prev) =>
        new Map(prev).set(
          id,
          result.status === 'ok'
            ? { status: 'ok', paystubs: result.paystubs }
            : { status: 'unavailable' },
        ),
      );
    });
    return () => {
      cancelled = true;
    };
  }, [expandedId, docs]);

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

  /** The expanded row: what this employee actually has on file. */
  const renderDocs = (employee: EmployeeRow) => {
    const state = docs.get(employee.id) ?? { status: 'loading' as const };
    if (state.status === 'loading') {
      return (
        <View style={styles.docsCard}>
          <ActivityIndicator color={colors.ocean} />
        </View>
      );
    }
    if (state.status === 'unavailable') {
      return (
        <View style={styles.docsCard}>
          <Text style={styles.docsText}>Documents are unavailable right now.</Text>
        </View>
      );
    }
    if (state.paystubs.length === 0) {
      return (
        <EmptyState
          icon="document-text"
          title="No documents on file"
          body="Paystubs uploaded on the Paystubs screen show up here."
        />
      );
    }
    const newest = state.paystubs[0];
    return (
      <View style={styles.docsCard}>
        <View style={styles.docsHeader}>
          <Ionicons name="document-text" size={16} color={colors.ocean} />
          <Text style={styles.docsTitle}>
            {state.paystubs.length === 1 ? '1 paystub' : `${state.paystubs.length} paystubs`}
          </Text>
        </View>
        <Text style={styles.docsText}>
          {newest.period_label
            ? `Most recent: ${newest.period_label}`
            : `Most recent: ${newest.created_at.slice(0, 10)}`}
        </Text>
      </View>
    );
  };

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
        {expanded ? <View style={styles.expandArea}>{renderDocs(employee)}</View> : null}
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
  docsCard: {
    gap: spacing.xs,
    backgroundColor: colors.skySoft,
    borderRadius: radii.sm,
    padding: spacing.md,
  },
  docsHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
  },
  docsTitle: {
    color: colors.ink,
    fontSize: 14,
    fontWeight: '700',
    flexShrink: 1,
  },
  docsText: {
    color: colors.inkSoft,
    fontSize: 13,
    fontWeight: '600',
  },
});
