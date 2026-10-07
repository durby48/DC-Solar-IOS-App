import Ionicons from '@expo/vector-icons/Ionicons';
import { useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';

import { colors, hubColors, radii, spacing } from '@/constants/theme';
import {
  activeCount,
  CONTACT_LABEL,
  CONTACT_ORDER,
  EMPTY_FILTERS,
  HAS_LABEL,
  SORT_LABEL,
  SORT_ORDER,
  STAGE_LABEL,
  STAGE_ORDER,
  type CrmFilters,
  type filterOptions,
  type HasFilter,
} from '@/lib/crmFilters';

/**
 * The CRM list's "Filter & sort" panel (2026-10-07) and the strip of active
 * filters shown above the list when the panel is closed. Logic and the
 * options' meaning live in lib/crmFilters.ts; this is only the chips.
 */

type Options = ReturnType<typeof filterOptions>;

function Pill({ label, on, onPress }: { label: string; on: boolean; onPress: () => void }) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="checkbox"
      accessibilityState={{ checked: on }}
      style={({ pressed }) => [styles.pill, on && styles.pillOn, pressed && styles.pressed]}>
      <Text style={[styles.pillText, on && styles.pillTextOn]} numberOfLines={1}>
        {label}
      </Text>
    </Pressable>
  );
}

function toggle<T>(list: T[], value: T): T[] {
  return list.includes(value) ? list.filter((v) => v !== value) : [...list, value];
}

/**
 * ZIP codes (2026-10-08): type and the matching ZIPs appear (with how many
 * records each), instead of every ZIP in the list as a wall of chips. Picked
 * ZIPs stay shown above the box; tap one to remove it.
 */
export function ZipPicker({
  zips,
  selected,
  onToggle,
}: {
  zips: { value: string; count: number }[];
  selected: string[];
  onToggle: (zip: string) => void;
}) {
  const [query, setQuery] = useState('');
  const q = query.replace(/[^0-9]/g, '');
  const matches = q ? zips.filter((z) => z.value.startsWith(q) && !selected.includes(z.value)).slice(0, 12) : [];
  const pick = (zip: string) => {
    onToggle(zip);
    setQuery('');
  };
  return (
    <View style={styles.zipBox}>
      {selected.length > 0 ? (
        <View style={styles.wrap}>
          {selected.map((z) => (
            <Pill key={z} label={`${z}  ✕`} on onPress={() => onToggle(z)} />
          ))}
        </View>
      ) : null}
      <View style={styles.searchRow}>
        <Ionicons name="search" size={14} color={colors.inkSoft} />
        <TextInput
          value={query}
          onChangeText={setQuery}
          placeholder={`Type a ZIP code (${zips.length} in this list)`}
          placeholderTextColor={colors.inkSoft}
          keyboardType="number-pad"
          maxLength={5}
          returnKeyType="done"
          onSubmitEditing={() => {
            if (matches.length > 0 && (matches.length === 1 || matches[0].value === q)) pick(matches[0].value);
          }}
          style={styles.searchInput}
        />
        {query ? (
          <Pressable onPress={() => setQuery('')} hitSlop={8} accessibilityLabel="Clear">
            <Ionicons name="close-circle" size={16} color={colors.inkSoft} />
          </Pressable>
        ) : null}
      </View>
      {q ? (
        matches.length === 0 ? (
          <Text style={styles.none}>No ZIP in this list starts with {q}.</Text>
        ) : (
          <View style={styles.wrap}>
            {matches.map((z) => (
              <Pill key={z.value} label={`${z.value} · ${z.count}`} on={false} onPress={() => pick(z.value)} />
            ))}
          </View>
        )
      ) : null}
    </View>
  );
}

export function FilterPanel({
  filters,
  onChange,
  options,
  reps,
  shown,
  onDone,
}: {
  filters: CrmFilters;
  onChange: (next: CrmFilters) => void;
  options: Options;
  /** Admins only: the people leads can be assigned to. */
  reps?: { email: string; name: string }[];
  /** How many records match right now. */
  shown: number;
  onDone: () => void;
}) {
  const set = (patch: Partial<CrmFilters>) => onChange({ ...filters, ...patch });

  return (
    <View style={styles.panel}>
      <View style={styles.head}>
        <Text style={styles.title}>Filter & sort</Text>
        {activeCount(filters) > 0 || filters.sort !== 'activity' ? (
          <Pressable onPress={() => onChange(EMPTY_FILTERS)} hitSlop={8}>
            <Text style={styles.clear}>Clear all</Text>
          </Pressable>
        ) : null}
      </View>
      <ScrollView style={styles.scroll} contentContainerStyle={styles.body} keyboardShouldPersistTaps="handled">
        <Text style={styles.section}>Sort</Text>
        <View style={styles.wrap}>
          {SORT_ORDER.map((s) => (
            <Pill key={s} label={SORT_LABEL[s]} on={filters.sort === s} onPress={() => set({ sort: s })} />
          ))}
        </View>

        <Text style={styles.section}>ZIP code</Text>
        {options.zips.length === 0 ? (
          <Text style={styles.none}>No ZIP codes in these addresses.</Text>
        ) : (
          <ZipPicker
            zips={options.zips}
            selected={filters.zips}
            onToggle={(z) => set({ zips: toggle(filters.zips, z) })}
          />
        )}

        <Text style={styles.section}>Stage</Text>
        <View style={styles.wrap}>
          {STAGE_ORDER.map((s) => (
            <Pill key={s} label={STAGE_LABEL[s]} on={filters.stages.includes(s)} onPress={() => set({ stages: toggle(filters.stages, s) })} />
          ))}
        </View>

        <Text style={styles.section}>Contact</Text>
        <View style={styles.wrap}>
          {CONTACT_ORDER.map((c) => (
            <Pill key={c} label={CONTACT_LABEL[c]} on={filters.contact.includes(c)} onPress={() => set({ contact: toggle(filters.contact, c) })} />
          ))}
        </View>

        {options.sources.length > 0 ? (
          <>
            <Text style={styles.section}>Source / list</Text>
            <View style={styles.wrap}>
              {options.sources.map((s) => (
                <Pill
                  key={s.value}
                  label={`${s.value} · ${s.count}`}
                  on={filters.sources.includes(s.value)}
                  onPress={() => set({ sources: toggle(filters.sources, s.value) })}
                />
              ))}
            </View>
          </>
        ) : null}

        {options.installers.length > 0 ? (
          <>
            <Text style={styles.section}>Original installer</Text>
            <View style={styles.wrap}>
              {options.installers.map((s) => (
                <Pill
                  key={s.value}
                  label={`${s.value} · ${s.count}`}
                  on={filters.installers.includes(s.value)}
                  onPress={() => set({ installers: toggle(filters.installers, s.value) })}
                />
              ))}
            </View>
          </>
        ) : null}

        {reps && reps.length > 0 ? (
          <>
            <Text style={styles.section}>Rep</Text>
            <View style={styles.wrap}>
              {reps.map((r) => (
                <Pill
                  key={r.email}
                  label={r.name}
                  on={filters.reps.includes(r.email.toLowerCase())}
                  onPress={() => set({ reps: toggle(filters.reps, r.email.toLowerCase()) })}
                />
              ))}
            </View>
          </>
        ) : null}

        <Text style={styles.section}>Has</Text>
        <View style={styles.wrap}>
          {(['phone', 'email'] as HasFilter[]).map((h) => (
            <Pill key={h} label={HAS_LABEL[h]} on={filters.has.includes(h)} onPress={() => set({ has: toggle(filters.has, h) })} />
          ))}
        </View>
      </ScrollView>
      <Pressable onPress={onDone} style={({ pressed }) => [styles.done, pressed && styles.pressed]}>
        <Text style={styles.doneText}>Show {shown}</Text>
      </Pressable>
    </View>
  );
}

/** The active filters as removable chips, above the list. Nothing when none. */
export function ActiveFilters({
  filters,
  onChange,
  repName,
  onOpen,
}: {
  filters: CrmFilters;
  onChange: (next: CrmFilters) => void;
  repName: (email: string) => string;
  onOpen: () => void;
}) {
  const chips: { key: string; label: string; remove: () => void }[] = [
    ...filters.zips.map((z) => ({ key: `z:${z}`, label: z, remove: () => onChange({ ...filters, zips: filters.zips.filter((x) => x !== z) }) })),
    ...filters.stages.map((s) => ({ key: `s:${s}`, label: STAGE_LABEL[s], remove: () => onChange({ ...filters, stages: filters.stages.filter((x) => x !== s) }) })),
    ...filters.contact.map((c) => ({ key: `c:${c}`, label: CONTACT_LABEL[c], remove: () => onChange({ ...filters, contact: filters.contact.filter((x) => x !== c) }) })),
    ...filters.sources.map((s) => ({ key: `o:${s}`, label: s, remove: () => onChange({ ...filters, sources: filters.sources.filter((x) => x !== s) }) })),
    ...filters.installers.map((s) => ({ key: `i:${s}`, label: s, remove: () => onChange({ ...filters, installers: filters.installers.filter((x) => x !== s) }) })),
    ...filters.reps.map((r) => ({ key: `r:${r}`, label: repName(r), remove: () => onChange({ ...filters, reps: filters.reps.filter((x) => x !== r) }) })),
    ...filters.has.map((h) => ({ key: `h:${h}`, label: HAS_LABEL[h], remove: () => onChange({ ...filters, has: filters.has.filter((x) => x !== h) }) })),
  ];
  if (filters.sort !== 'activity') {
    chips.unshift({ key: 'sort', label: `Sort: ${SORT_LABEL[filters.sort]}`, remove: () => onChange({ ...filters, sort: 'activity' }) });
  }
  if (chips.length === 0) return null;
  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.strip} contentContainerStyle={styles.stripBody}>
      {chips.map((c) => (
        <Pressable key={c.key} onPress={c.remove} style={({ pressed }) => [styles.active, pressed && styles.pressed]} accessibilityLabel={`Remove ${c.label}`}>
          <Text style={styles.activeText} numberOfLines={1}>
            {c.label}
          </Text>
          <Ionicons name="close" size={12} color={hubColors.crm.deep} />
        </Pressable>
      ))}
      <Pressable onPress={onOpen} style={({ pressed }) => [styles.edit, pressed && styles.pressed]}>
        <Text style={styles.editText}>Edit</Text>
      </Pressable>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  panel: { flex: 1, backgroundColor: colors.surface },
  head: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.md,
    paddingTop: spacing.sm,
  },
  title: { color: colors.ink, fontSize: 15, fontWeight: '800' },
  clear: { color: colors.ocean, fontSize: 13, fontWeight: '800' },
  scroll: { flex: 1 },
  body: { padding: spacing.md, gap: spacing.xs, paddingBottom: spacing.lg },
  section: { color: colors.inkSoft, fontSize: 11, fontWeight: '800', letterSpacing: 0.5, textTransform: 'uppercase', marginTop: spacing.sm },
  none: { color: colors.inkSoft, fontSize: 12 },
  wrap: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  zipBox: { gap: 6 },
  searchRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.line,
    borderRadius: radii.pill,
    paddingHorizontal: spacing.sm + 2,
    backgroundColor: colors.surfaceAlt,
  },
  searchInput: { flex: 1, color: colors.ink, fontSize: 13, fontWeight: '600', paddingVertical: 7 },
  pill: { paddingHorizontal: spacing.sm + 2, paddingVertical: 5, borderRadius: radii.pill, backgroundColor: hubColors.crm.bg, maxWidth: 260 },
  pillOn: { backgroundColor: hubColors.crm.fg },
  pillText: { color: hubColors.crm.deep, fontSize: 12, fontWeight: '700' },
  pillTextOn: { color: colors.white },
  done: {
    margin: spacing.md,
    marginTop: 0,
    backgroundColor: colors.sun,
    borderRadius: radii.pill,
    paddingVertical: spacing.sm + 2,
    alignItems: 'center',
  },
  doneText: { color: colors.textOnAction, fontSize: 14, fontWeight: '800' },
  strip: { flexGrow: 0, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.line },
  stripBody: { gap: 6, paddingHorizontal: spacing.md, paddingVertical: spacing.xs + 2, alignItems: 'center' },
  active: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: spacing.sm,
    paddingVertical: 4,
    borderRadius: radii.pill,
    backgroundColor: hubColors.crm.bg,
    maxWidth: 220,
  },
  activeText: { color: hubColors.crm.deep, fontSize: 12, fontWeight: '700', flexShrink: 1 },
  edit: { paddingHorizontal: spacing.sm, paddingVertical: 4 },
  editText: { color: colors.ocean, fontSize: 12, fontWeight: '800' },
  pressed: { opacity: 0.6 },
});
