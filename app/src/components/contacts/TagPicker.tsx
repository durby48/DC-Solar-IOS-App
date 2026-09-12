import Ionicons from '@expo/vector-icons/Ionicons';
import { useState } from 'react';
import { Pressable, StyleSheet, TextInput, View } from 'react-native';

import { Chip } from '@/components/ui';
import { colors, radii, spacing } from '@/constants/theme';
import { PRESET_TAGS, normalizeTags, tagLabel } from '@/lib/contacts';

/**
 * Pick any number of tags for a contact: the ones already in use, the
 * starting vocabulary, and anything typed. A typed tag is lowercased and
 * joins the chips immediately, selected — there is no separate "create tag"
 * step because the whole point is Devon's own words ("city inspector").
 */
export function TagPicker({
  value,
  onChange,
  suggestions = [],
  accent = colors.ocean,
}: {
  value: string[];
  onChange: (tags: string[]) => void;
  /** Tags already in the directory, most-used first. */
  suggestions?: readonly string[];
  accent?: string;
}) {
  const [draft, setDraft] = useState('');

  const options = normalizeTags([...value, ...suggestions, ...PRESET_TAGS]);

  const toggle = (tag: string) => {
    onChange(value.includes(tag) ? value.filter((t) => t !== tag) : [...value, tag]);
  };

  const add = () => {
    const [tag] = normalizeTags([draft]);
    setDraft('');
    if (!tag || value.includes(tag)) return;
    onChange([...value, tag]);
  };

  return (
    <View style={styles.wrap}>
      <View style={styles.chips}>
        {options.map((tag) => (
          <Chip
            key={tag}
            label={tagLabel(tag)}
            tone="ocean"
            selected={value.includes(tag)}
            onPress={() => toggle(tag)}
          />
        ))}
      </View>
      <View style={styles.addRow}>
        <TextInput
          value={draft}
          onChangeText={setDraft}
          onSubmitEditing={add}
          placeholder="Add a tag, e.g. city inspector"
          placeholderTextColor={colors.inkSoft}
          autoCapitalize="none"
          autoCorrect={false}
          returnKeyType="done"
          blurOnSubmit={false}
          style={styles.input}
        />
        <Pressable
          onPress={add}
          disabled={!draft.trim()}
          hitSlop={6}
          accessibilityLabel="Add tag"
          style={({ pressed }) => [styles.addButton, !draft.trim() && styles.muted, pressed && styles.pressed]}>
          <Ionicons name="add" size={18} color={accent} />
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { gap: spacing.sm },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.xs },
  addRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs },
  input: {
    flex: 1,
    backgroundColor: colors.surfaceSunk,
    borderRadius: radii.sm,
    borderWidth: 1,
    borderColor: colors.line,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    color: colors.ink,
    fontSize: 14,
    fontWeight: '500',
  },
  addButton: {
    width: 36,
    height: 36,
    borderRadius: radii.sm,
    borderWidth: 1,
    borderColor: colors.line,
    backgroundColor: colors.surface,
    alignItems: 'center',
    justifyContent: 'center',
  },
  muted: { opacity: 0.4 },
  pressed: { opacity: 0.6 },
});
