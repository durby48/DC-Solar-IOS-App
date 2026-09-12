import Ionicons from '@expo/vector-icons/Ionicons';
import { useState } from 'react';
import {
  ActivityIndicator,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  View,
} from 'react-native';

import { colors, hubColors, radii, shadows, spacing } from '@/constants/theme';
import { createLabel, type MailLabel } from '@/lib/gmail';
import * as haptics from '@/lib/haptics';

/**
 * "Move to label" — Gmail's label menu as a sheet. Pick a custom label, or
 * type a new one and it is created in Gmail first. The "also remove from
 * Inbox" switch is what makes it a MOVE rather than a tag; it defaults on
 * when the conversation is still in the inbox, the way Gmail's Move to does.
 */
export function LabelPicker({
  visible,
  labels,
  inInbox,
  count,
  onClose,
  onPick,
  onLabelCreated,
}: {
  visible: boolean;
  labels: MailLabel[];
  /** Whether the conversation(s) are currently in the inbox — sets the switch's default. */
  inInbox: boolean;
  count: number;
  onClose: () => void;
  onPick: (label: MailLabel, archive: boolean) => void;
  onLabelCreated?: (label: MailLabel) => void;
}) {
  const [archive, setArchive] = useState(inInbox);
  const [name, setName] = useState('');
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const custom = labels.filter((l) => l.type === 'user');

  const create = async () => {
    if (!name.trim() || creating) return;
    setCreating(true);
    setError(null);
    const result = await createLabel(name.trim());
    setCreating(false);
    if (!result.ok) {
      setError(result.message);
      return;
    }
    haptics.success();
    setName('');
    onLabelCreated?.(result.label);
    onPick(result.label, archive);
  };

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <Pressable style={styles.scrim} onPress={onClose} accessibilityLabel="Close">
        <Pressable style={styles.sheet} onPress={() => undefined}>
          <View style={styles.head}>
            <Text style={styles.title}>
              {count > 1 ? `Move ${count} conversations to` : 'Move to'}
            </Text>
            <Pressable onPress={onClose} hitSlop={10} accessibilityLabel="Close">
              <Ionicons name="close" size={20} color={colors.inkSoft} />
            </Pressable>
          </View>

          <View style={styles.switchRow}>
            <Text style={styles.switchText}>Also remove from Inbox</Text>
            <Switch
              value={archive}
              onValueChange={setArchive}
              trackColor={{ true: hubColors.crm.fg, false: colors.borderStrong }}
              thumbColor={colors.white}
            />
          </View>

          <ScrollView style={styles.list} keyboardShouldPersistTaps="handled">
            {custom.length === 0 ? (
              <Text style={styles.empty}>No labels yet. Make one below.</Text>
            ) : (
              custom.map((label) => (
                <Pressable
                  key={label.id}
                  onPress={() => {
                    haptics.tapLight();
                    onPick(label, archive);
                  }}
                  style={({ pressed }) => [styles.item, pressed && styles.pressed]}>
                  <Ionicons name="pricetag-outline" size={16} color={hubColors.crm.fg} />
                  <Text style={styles.itemText} numberOfLines={1}>
                    {label.name}
                  </Text>
                </Pressable>
              ))
            )}
          </ScrollView>

          <View style={styles.newRow}>
            <TextInput
              value={name}
              onChangeText={setName}
              onSubmitEditing={() => void create()}
              placeholder="New label"
              placeholderTextColor={colors.textMuted}
              autoCapitalize="words"
              style={styles.input}
            />
            <Pressable
              onPress={() => void create()}
              disabled={!name.trim() || creating}
              style={({ pressed }) => [styles.createButton, (!name.trim() || creating || pressed) && styles.pressed]}>
              {creating ? (
                <ActivityIndicator color={colors.textInverse} size="small" />
              ) : (
                <Text style={styles.createText}>Create</Text>
              )}
            </Pressable>
          </View>
          {error ? <Text style={styles.error}>{error}</Text> : null}
        </Pressable>
      </Pressable>
    </Modal>
  );
}

const styles = StyleSheet.create({
  scrim: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.35)',
    alignItems: 'center',
    justifyContent: 'center',
    padding: spacing.lg,
  },
  sheet: {
    width: '100%',
    maxWidth: 380,
    maxHeight: '80%',
    backgroundColor: colors.surface,
    borderRadius: radii.md,
    padding: spacing.md,
    gap: spacing.sm,
    ...shadows.raised,
  },
  head: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  title: { color: colors.ink, fontSize: 16, fontWeight: '800' },
  switchRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: colors.surfaceSunk,
    borderRadius: radii.sm,
    paddingHorizontal: spacing.sm + 2,
    paddingVertical: spacing.xs,
  },
  switchText: { color: colors.ink, fontSize: 13, fontWeight: '600' },
  list: { maxHeight: 260 },
  empty: { color: colors.textMuted, fontSize: 13, fontWeight: '600', padding: spacing.sm },
  item: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingVertical: spacing.sm + 2,
    paddingHorizontal: spacing.xs,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.line,
  },
  itemText: { flex: 1, color: colors.ink, fontSize: 14, fontWeight: '600' },
  newRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  input: {
    flex: 1,
    backgroundColor: colors.canvas,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radii.sm,
    paddingHorizontal: spacing.sm + 2,
    paddingVertical: spacing.sm,
    color: colors.ink,
    fontSize: 14,
    fontWeight: '600',
  },
  createButton: {
    backgroundColor: hubColors.crm.fg,
    borderRadius: radii.pill,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    minWidth: 72,
    alignItems: 'center',
  },
  createText: { color: colors.textInverse, fontSize: 13, fontWeight: '800' },
  error: { color: colors.danger, fontSize: 12, fontWeight: '700' },
  pressed: { opacity: 0.6 },
});
