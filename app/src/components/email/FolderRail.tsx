import Ionicons from '@expo/vector-icons/Ionicons';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { colors, hubColors, radii, spacing } from '@/constants/theme';
import type { MailFolder, MailLabel } from '@/lib/gmail';
import * as haptics from '@/lib/haptics';

import { SYSTEM_FOLDERS, labelLeaf, type IconName } from './format';

/**
 * The folder list: Gmail's left sidebar on a wide screen, a scrolling chip
 * strip on a phone. Same items in both — the fixed folders, then every
 * custom label — with the unread count Gmail reports for each.
 */

interface Item {
  key: MailFolder;
  label: string;
  icon: IconName;
  count: number | null;
  custom: boolean;
}

function items(labels: MailLabel[]): Item[] {
  const byId = new Map(labels.map((l) => [l.id, l]));
  const fixed: Item[] = SYSTEM_FOLDERS.map((f) => {
    const l = f.labelId ? byId.get(f.labelId) : undefined;
    // Drafts and Trash are "how many", the rest are "how many unread".
    const count = f.key === 'drafts' ? (l?.threadsTotal ?? null) : (l?.threadsUnread ?? null);
    return { key: f.key, label: f.label, icon: f.icon, count: count && count > 0 ? count : null, custom: false };
  });
  const custom: Item[] = labels
    .filter((l) => l.type === 'user')
    .map((l) => ({
      key: `label:${l.id}` as MailFolder,
      label: labelLeaf(l.name),
      icon: 'pricetag' as IconName,
      count: l.threadsUnread && l.threadsUnread > 0 ? l.threadsUnread : null,
      custom: true,
    }));
  return [...fixed, ...custom];
}

export function FolderRail({
  active,
  labels,
  onPick,
  onCompose,
  mailbox,
}: {
  active: MailFolder;
  labels: MailLabel[];
  onPick: (folder: MailFolder) => void;
  onCompose: () => void;
  mailbox: string | null;
}) {
  const list = items(labels);
  const firstCustom = list.findIndex((i) => i.custom);
  return (
    <View style={styles.rail}>
      <Pressable
        onPress={() => {
          haptics.tapMedium();
          onCompose();
        }}
        accessibilityRole="button"
        style={({ pressed }) => [styles.compose, pressed && styles.pressed]}>
        <Ionicons name="pencil" size={18} color={colors.white} />
        <Text style={styles.composeText}>Compose</Text>
      </Pressable>
      <ScrollView contentContainerStyle={styles.railList} showsVerticalScrollIndicator={false}>
        {list.map((item, index) => {
          const selected = item.key === active;
          return (
            <View key={item.key}>
              {index === firstCustom ? <Text style={styles.railSection}>Labels</Text> : null}
              <Pressable
                onPress={() => onPick(item.key)}
                accessibilityRole="button"
                accessibilityState={{ selected }}
                style={({ pressed }) => [styles.railItem, selected && styles.railItemActive, pressed && styles.pressed]}>
                <Ionicons
                  name={selected ? item.icon : (`${item.icon}-outline` as IconName)}
                  size={17}
                  color={selected ? hubColors.crm.fg : colors.inkSoft}
                />
                <Text style={[styles.railLabel, selected && styles.railLabelActive]} numberOfLines={1}>
                  {item.label}
                </Text>
                {item.count ? (
                  <Text style={[styles.railCount, selected && styles.railCountActive]}>{item.count}</Text>
                ) : null}
              </Pressable>
            </View>
          );
        })}
      </ScrollView>
      {mailbox ? (
        <Text style={styles.railMailbox} numberOfLines={1}>
          {mailbox}
        </Text>
      ) : null}
    </View>
  );
}

/** Phone: the same folders as a horizontal chip strip. */
export function FolderStrip({
  active,
  labels,
  onPick,
}: {
  active: MailFolder;
  labels: MailLabel[];
  onPick: (folder: MailFolder) => void;
}) {
  const list = items(labels);
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      contentContainerStyle={styles.strip}
      keyboardShouldPersistTaps="handled">
      {list.map((item) => {
        const selected = item.key === active;
        return (
          <Pressable
            key={item.key}
            onPress={() => {
              if (selected) return;
              haptics.tapLight();
              onPick(item.key);
            }}
            accessibilityRole="button"
            accessibilityState={{ selected }}
            style={({ pressed }) => [styles.chip, selected && styles.chipActive, pressed && styles.pressed]}>
            <Ionicons
              name={selected ? item.icon : (`${item.icon}-outline` as IconName)}
              size={14}
              color={selected ? colors.white : colors.inkSoft}
            />
            <Text style={[styles.chipText, selected && styles.chipTextActive]} numberOfLines={1}>
              {item.label}
            </Text>
            {item.count ? (
              <Text style={[styles.chipCount, selected && styles.chipCountActive]}>{item.count}</Text>
            ) : null}
          </Pressable>
        );
      })}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  rail: {
    width: 224,
    backgroundColor: colors.surfaceAlt,
    borderRightWidth: StyleSheet.hairlineWidth,
    borderRightColor: colors.line,
    paddingTop: spacing.md,
    paddingBottom: spacing.sm,
  },
  compose: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    alignSelf: 'flex-start',
    marginHorizontal: spacing.md,
    marginBottom: spacing.md,
    backgroundColor: hubColors.crm.fg,
    borderRadius: radii.pill,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm + 4,
  },
  composeText: { color: colors.white, fontSize: 14, fontWeight: '800' },
  railList: { paddingRight: spacing.sm, paddingBottom: spacing.md },
  railSection: {
    color: colors.textMuted,
    fontSize: 11,
    fontWeight: '800',
    letterSpacing: 0.6,
    textTransform: 'uppercase',
    marginTop: spacing.md,
    marginBottom: spacing.xs,
    marginLeft: spacing.md,
  },
  railItem: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm + 2,
    paddingVertical: 7,
    paddingLeft: spacing.md,
    paddingRight: spacing.sm,
    borderTopRightRadius: radii.pill,
    borderBottomRightRadius: radii.pill,
  },
  railItemActive: { backgroundColor: hubColors.crm.bg },
  railLabel: { flex: 1, color: colors.ink, fontSize: 14, fontWeight: '600' },
  railLabelActive: { color: hubColors.crm.deep, fontWeight: '800' },
  railCount: { color: colors.inkSoft, fontSize: 12, fontWeight: '800' },
  railCountActive: { color: hubColors.crm.deep },
  railMailbox: {
    color: colors.textMuted,
    fontSize: 11,
    fontWeight: '600',
    marginHorizontal: spacing.md,
    marginTop: spacing.xs,
  },

  strip: { gap: spacing.xs, paddingHorizontal: spacing.md, paddingVertical: spacing.xs },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    backgroundColor: colors.white,
    borderRadius: radii.pill,
    paddingHorizontal: spacing.sm + 4,
    paddingVertical: 6,
    borderWidth: 1,
    borderColor: colors.border,
  },
  chipActive: { backgroundColor: hubColors.crm.fg, borderColor: hubColors.crm.fg },
  chipText: { color: colors.inkSoft, fontSize: 12, fontWeight: '800' },
  chipTextActive: { color: colors.white },
  chipCount: { color: colors.textMuted, fontSize: 11, fontWeight: '800' },
  chipCountActive: { color: colors.white },
  pressed: { opacity: 0.75 },
});
