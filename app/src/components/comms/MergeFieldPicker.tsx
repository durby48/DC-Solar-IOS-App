import Ionicons from '@expo/vector-icons/Ionicons';
import { useMemo, useState } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import { colors, hubColors, radii, spacing } from '@/constants/theme';
import { TEMPLATE_FIELDS } from '@/lib/comms';

/**
 * "Add a field" for a saved text (2026-10-09, Carson: "add a spot to search
 * for Fields to add to the saved text"). A search box over the merge fields
 * (lib/comms TEMPLATE_FIELDS) by plain name — "first", "address", "link" —
 * and a chip per match; tapping one hands back `{{token}}` for the editor to
 * drop in at the cursor.
 */
export function MergeFieldPicker({ onPick }: { onPick: (token: string) => void }) {
  const [query, setQuery] = useState('');
  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return TEMPLATE_FIELDS;
    return TEMPLATE_FIELDS.filter((f) =>
      `${f.label} ${f.token} ${f.keywords ?? ''}`.toLowerCase().includes(q),
    );
  }, [query]);

  return (
    <View style={styles.wrap}>
      <View style={styles.search}>
        <Ionicons name="search" size={16} color={colors.textMuted} />
        <TextInput
          value={query}
          onChangeText={setQuery}
          placeholder="Search fields — first name, address, link…"
          placeholderTextColor={colors.textMuted}
          autoCapitalize="none"
          autoCorrect={false}
          style={styles.input}
        />
        {query ? (
          <Pressable onPress={() => setQuery('')} hitSlop={8} accessibilityLabel="Clear field search">
            <Ionicons name="close-circle" size={16} color={colors.textMuted} />
          </Pressable>
        ) : null}
      </View>
      <View style={styles.chips}>
        {shown.length === 0 ? <Text style={styles.empty}>No field matches “{query.trim()}”.</Text> : null}
        {shown.map((f) => (
          <Pressable
            key={f.token}
            onPress={() => onPick(`{{${f.token}}}`)}
            accessibilityLabel={`Add ${f.label}`}
            style={({ pressed }) => [styles.chip, pressed && styles.pressed]}>
            <Ionicons name="add" size={14} color={hubColors.crm.deep} />
            <Text style={styles.chipLabel}>{f.label}</Text>
            <Text style={styles.chipExample} numberOfLines={1}>
              {f.example}
            </Text>
          </Pressable>
        ))}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { gap: spacing.sm },
  search: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    backgroundColor: colors.surfaceSunk,
    borderRadius: radii.sm,
    borderWidth: 1,
    borderColor: colors.border,
    paddingHorizontal: spacing.md,
  },
  input: { flex: 1, minWidth: 0, color: colors.textPrimary, fontSize: 15, paddingVertical: spacing.sm + 2 },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.xs + 2 },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    maxWidth: '100%',
    backgroundColor: hubColors.crm.bg,
    borderRadius: radii.pill,
    paddingHorizontal: spacing.sm + 2,
    paddingVertical: 7,
  },
  chipLabel: { color: hubColors.crm.deep, fontSize: 13, fontWeight: '800' },
  chipExample: { flexShrink: 1, color: colors.textMuted, fontSize: 12, fontWeight: '600' },
  empty: { color: colors.textMuted, fontSize: 13 },
  pressed: { opacity: 0.6 },
});
