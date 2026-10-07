import Ionicons from '@expo/vector-icons/Ionicons';
import { Stack, useFocusEffect } from 'expo-router';
import { useCallback, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';

import { AppText, Card, Screen } from '@/components/ui';
import { colors, hubColors, radii, spacing } from '@/constants/theme';
import { useRoleGate } from '@/lib/role';
import { deleteLeadsForever, fetchRemovedLeads, restoreLeads, type RemovedLead } from '@/lib/sales';
import { personName } from '@/lib/staffNames';

/**
 * `/removed-leads` — leads someone removed (2026-10-08). Admins (and
 * developers) restore them, or delete them for good (two taps). Opened from
 * the CRM hub and from the bottom of Assign leads. Removing hides a lead
 * everywhere else; see 2026-10-08_remove_leads.sql.
 */
export default function RemovedLeadsScreen() {
  const gate = useRoleGate();
  const allowed = gate.role?.isAdmin === true;
  const [rows, setRows] = useState<RemovedLead[] | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);

  const load = useCallback(async () => {
    setRows(await fetchRemovedLeads());
  }, []);
  useFocusEffect(
    useCallback(() => {
      if (allowed) void load();
    }, [allowed, load]),
  );

  if (gate.phase === 'loading') {
    return (
      <Screen edges={[]}>
        <Stack.Screen options={{ title: 'Removed leads' }} />
        <ActivityIndicator color={hubColors.crm.fg} style={styles.loading} />
      </Screen>
    );
  }
  if (!allowed) {
    return (
      <Screen edges={[]}>
        <Stack.Screen options={{ title: 'Removed leads' }} />
        <AppText variant="body" color={colors.textSecondary}>
          Removed leads are for admins.
        </AppText>
      </Screen>
    );
  }

  const ids = [...selected];
  const act = async (kind: 'restore' | 'delete') => {
    if (ids.length === 0) return;
    setBusy(true);
    setNote(null);
    const result = kind === 'restore' ? await restoreLeads(ids) : await deleteLeadsForever(ids);
    setBusy(false);
    setConfirmDelete(false);
    if (result.ok) {
      setNote({
        ok: true,
        text:
          kind === 'restore'
            ? `Restored ${result.count} — they're back in the CRM.`
            : `Deleted ${result.count} for good.`,
      });
      setSelected(new Set());
      void load();
    } else {
      setNote({ ok: false, text: result.message });
    }
  };

  return (
    <Screen edges={[]} contentContainerStyle={styles.content}>
      <Stack.Screen options={{ title: 'Removed leads' }} />
      <AppText variant="caption" color={colors.textSecondary}>
        Removed leads are hidden from the CRM, the map and every count. Restore one to bring it back, or delete it
        for good.
      </AppText>

      {note ? <Text style={[styles.note, !note.ok && styles.noteBad]}>{note.text}</Text> : null}

      {!rows ? (
        <ActivityIndicator color={hubColors.crm.fg} style={styles.loading} />
      ) : rows.length === 0 ? (
        <AppText variant="body" color={colors.textSecondary}>
          Nothing removed.
        </AppText>
      ) : (
        <>
          <View style={styles.countRow}>
            <Text style={styles.countText}>
              {rows.length} removed{selected.size ? ` · ${selected.size} selected` : ''}
            </Text>
            <View style={styles.countActions}>
              <Pressable onPress={() => setSelected(new Set(rows.map((r) => r.id)))} hitSlop={8}>
                <Text style={styles.link}>Select all</Text>
              </Pressable>
              {selected.size ? (
                <Pressable onPress={() => setSelected(new Set())} hitSlop={8}>
                  <Text style={styles.link}>Clear</Text>
                </Pressable>
              ) : null}
            </View>
          </View>
          <Card padded={false}>
            {rows.map((r, i) => {
              const on = selected.has(r.id);
              return (
                <Pressable
                  key={r.id}
                  onPress={() =>
                    setSelected((cur) => {
                      const next = new Set(cur);
                      if (next.has(r.id)) next.delete(r.id);
                      else next.add(r.id);
                      return next;
                    })
                  }
                  style={({ pressed }) => [styles.row, i > 0 && styles.rowBorder, on && styles.rowOn, pressed && styles.pressed]}>
                  <Ionicons name={on ? 'checkbox' : 'square-outline'} size={20} color={on ? hubColors.crm.fg : colors.inkSoft} />
                  <View style={styles.rowBody}>
                    <Text style={styles.rowName} numberOfLines={1}>
                      {r.name}
                    </Text>
                    <Text style={styles.rowSub} numberOfLines={1}>
                      Removed {new Date(r.removedAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
                      {r.removedBy ? ` by ${personName(r.removedBy)}` : ''}
                      {r.address ? ` · ${r.address}` : ''}
                    </Text>
                  </View>
                </Pressable>
              );
            })}
          </Card>

          {selected.size ? (
            confirmDelete ? (
              <View style={styles.confirm}>
                <Text style={styles.confirmText}>
                  Delete {selected.size} lead{selected.size === 1 ? '' : 's'} for good? Their tasks and appointments go
                  too. This can't be undone.
                </Text>
                <View style={styles.buttons}>
                  <Pressable onPress={() => setConfirmDelete(false)} style={({ pressed }) => [styles.ghost, pressed && styles.pressed]}>
                    <Text style={styles.ghostText}>Cancel</Text>
                  </Pressable>
                  <Pressable
                    onPress={() => void act('delete')}
                    disabled={busy}
                    style={({ pressed }) => [styles.danger, (pressed || busy) && styles.pressed]}>
                    {busy ? <ActivityIndicator color="#fff" /> : <Text style={styles.dangerText}>Delete for good</Text>}
                  </Pressable>
                </View>
              </View>
            ) : (
              <View style={styles.buttons}>
                <Pressable onPress={() => setConfirmDelete(true)} style={({ pressed }) => [styles.ghost, pressed && styles.pressed]}>
                  <Text style={[styles.ghostText, styles.dangerInk]}>Delete for good…</Text>
                </Pressable>
                <Pressable
                  onPress={() => void act('restore')}
                  disabled={busy}
                  style={({ pressed }) => [styles.primary, (pressed || busy) && styles.pressed]}>
                  {busy ? (
                    <ActivityIndicator color={colors.textOnAction} />
                  ) : (
                    <Text style={styles.primaryText}>Restore {selected.size}</Text>
                  )}
                </Pressable>
              </View>
            )
          ) : null}
        </>
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  content: { width: '100%', maxWidth: 640, alignSelf: 'center', gap: spacing.md, paddingBottom: spacing.xl },
  loading: { marginVertical: spacing.xl },
  note: { color: colors.success, fontSize: 13, fontWeight: '800' },
  noteBad: { color: colors.danger },
  countRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  countText: { color: colors.ink, fontSize: 14, fontWeight: '800' },
  countActions: { flexDirection: 'row', gap: spacing.md },
  link: { color: colors.ocean, fontSize: 13, fontWeight: '800' },
  row: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, padding: spacing.md, backgroundColor: colors.surface },
  rowBorder: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.line },
  rowOn: { backgroundColor: hubColors.crm.bg },
  rowBody: { flex: 1, minWidth: 0 },
  rowName: { color: colors.ink, fontSize: 14, fontWeight: '800' },
  rowSub: { color: colors.inkSoft, fontSize: 12, fontWeight: '600', marginTop: 1 },
  buttons: { flexDirection: 'row', justifyContent: 'flex-end', alignItems: 'center', gap: spacing.sm },
  primary: { backgroundColor: colors.sun, borderRadius: radii.pill, paddingHorizontal: spacing.lg, paddingVertical: 9, minWidth: 110, alignItems: 'center' },
  primaryText: { color: colors.textOnAction, fontSize: 14, fontWeight: '800' },
  ghost: { paddingHorizontal: spacing.md, paddingVertical: 9, borderRadius: radii.pill },
  ghostText: { color: colors.inkSoft, fontSize: 13, fontWeight: '700' },
  dangerInk: { color: colors.danger },
  danger: { backgroundColor: colors.danger, borderRadius: radii.pill, paddingHorizontal: spacing.lg, paddingVertical: 9, alignItems: 'center' },
  dangerText: { color: '#fff', fontSize: 14, fontWeight: '800' },
  confirm: { gap: spacing.sm, backgroundColor: colors.dangerSoft, borderRadius: radii.md, padding: spacing.md },
  confirmText: { color: colors.ink, fontSize: 13, fontWeight: '700' },
  pressed: { opacity: 0.6 },
});
