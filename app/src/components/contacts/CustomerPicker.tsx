import Ionicons from '@expo/vector-icons/Ionicons';
import { useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import { colors, hubColors, radii, spacing } from '@/constants/theme';
import { fetchCrmCustomers } from '@/lib/crm';

export interface PickedCustomer {
  id: string;
  name: string;
}

const MAX_ROWS = 12;

/**
 * "Attach to a customer": a search box over the customer list, inline, no
 * modal. Loads the list the first time it is opened — the import screen and
 * the contact editor both show this collapsed most of the time and should
 * not pay for 200 customer rows until somebody wants one.
 */
export function CustomerPicker({
  value,
  onChange,
  locked = false,
}: {
  value: PickedCustomer | null;
  onChange: (customer: PickedCustomer | null) => void;
  /** The customer record's own segment: the link is fixed, show it and stop. */
  locked?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [customers, setCustomers] = useState<PickedCustomer[] | null>(null);
  const [search, setSearch] = useState('');

  useEffect(() => {
    if (!open || customers !== null || loading) return;
    let cancelled = false;
    setLoading(true);
    void fetchCrmCustomers().then((result) => {
      if (cancelled) return;
      setCustomers(result.status === 'ok' ? result.customers.map((c) => ({ id: c.id, name: c.name })) : []);
      setLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [open, customers, loading]);

  if (locked) {
    return (
      <View style={styles.valueRow}>
        <Ionicons name="business-outline" size={16} color={hubColors.crm.fg} />
        <Text style={styles.valueText} numberOfLines={1}>
          {value?.name ?? 'No customer'}
        </Text>
      </View>
    );
  }

  const q = search.trim().toLowerCase();
  const rows = (customers ?? []).filter((c) => !q || c.name.toLowerCase().includes(q)).slice(0, MAX_ROWS);

  return (
    <View style={styles.wrap}>
      <Pressable
        onPress={() => setOpen((v) => !v)}
        style={({ pressed }) => [styles.valueRow, pressed && styles.pressed]}
        accessibilityRole="button"
        accessibilityLabel={value ? `Attached to ${value.name}` : 'Attach to a customer'}>
        <Ionicons name="business-outline" size={16} color={hubColors.crm.fg} />
        <Text style={[styles.valueText, !value && styles.valueMuted]} numberOfLines={1}>
          {value ? value.name : 'Not attached to a customer'}
        </Text>
        {value ? (
          <Pressable onPress={() => onChange(null)} hitSlop={8} accessibilityLabel="Detach customer">
            <Ionicons name="close-circle" size={18} color={colors.inkSoft} />
          </Pressable>
        ) : (
          <Ionicons name={open ? 'chevron-up' : 'chevron-down'} size={16} color={colors.inkSoft} />
        )}
      </Pressable>

      {open ? (
        <View style={styles.list}>
          <View style={styles.searchRow}>
            <Ionicons name="search" size={14} color={colors.inkSoft} />
            <TextInput
              value={search}
              onChangeText={setSearch}
              placeholder="Search customers"
              placeholderTextColor={colors.inkSoft}
              autoCapitalize="none"
              autoCorrect={false}
              style={styles.searchInput}
            />
          </View>
          {loading ? (
            <ActivityIndicator color={hubColors.crm.fg} style={styles.spinner} />
          ) : rows.length === 0 ? (
            <Text style={styles.empty}>{customers && customers.length > 0 ? 'No customer matches.' : 'No customers to show.'}</Text>
          ) : (
            rows.map((c) => (
              <Pressable
                key={c.id}
                onPress={() => {
                  onChange(c);
                  setOpen(false);
                  setSearch('');
                }}
                style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}>
                <Text style={styles.rowText} numberOfLines={1}>
                  {c.name}
                </Text>
                {value?.id === c.id ? <Ionicons name="checkmark" size={16} color={hubColors.crm.fg} /> : null}
              </Pressable>
            ))
          )}
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { gap: spacing.xs },
  valueRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    backgroundColor: colors.surfaceSunk,
    borderRadius: radii.sm,
    borderWidth: 1,
    borderColor: colors.line,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm + 2,
  },
  valueText: { flex: 1, color: colors.ink, fontSize: 14, fontWeight: '600' },
  valueMuted: { color: colors.inkSoft, fontWeight: '500' },
  list: {
    backgroundColor: colors.white,
    borderRadius: radii.sm,
    borderWidth: 1,
    borderColor: colors.line,
    overflow: 'hidden',
  },
  searchRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.line,
  },
  searchInput: { flex: 1, color: colors.ink, fontSize: 14, fontWeight: '500', paddingVertical: 2 },
  spinner: { paddingVertical: spacing.md },
  empty: { color: colors.inkSoft, fontSize: 13, fontWeight: '600', padding: spacing.md },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm + 2,
  },
  rowPressed: { backgroundColor: hubColors.crm.bg },
  rowText: { flex: 1, color: colors.ink, fontSize: 14, fontWeight: '600' },
  pressed: { opacity: 0.7 },
});
