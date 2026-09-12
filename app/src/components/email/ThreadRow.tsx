import Ionicons from '@expo/vector-icons/Ionicons';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { colors, hubColors, spacing } from '@/constants/theme';
import type { InboxThread, MailFolder } from '@/lib/gmail';
import * as haptics from '@/lib/haptics';

import { relativeTime } from './format';

/**
 * One conversation in the list, Gmail-shaped: checkbox, star, who, subject
 * + snippet, time. The checkbox and star are SIBLINGS of the row's press
 * target, not children — nested Pressables both fire on react-native-web.
 */
export function ThreadRow({
  item,
  folder,
  selected,
  selectable,
  active,
  onPress,
  onLongPress,
  onToggleSelect,
  onToggleStar,
}: {
  item: InboxThread;
  folder: MailFolder;
  /** Ticked in a multi-select. */
  selected: boolean;
  /** Draw the checkbox at all (wide layouts always; phones only in select mode). */
  selectable: boolean;
  /** Open in the reading pane beside the list. */
  active: boolean;
  onPress: () => void;
  onLongPress?: () => void;
  onToggleSelect: () => void;
  onToggleStar: () => void;
}) {
  // Sent and Drafts rows say who they went TO; everything else says who wrote.
  const outbound = folder === 'sent' || folder === 'drafts' || item.isDraft;
  const who = outbound
    ? `${item.isDraft ? '' : 'To: '}${item.toNames || item.to || '(no recipient)'}`
    : item.fromName || item.from || 'Unknown sender';

  return (
    <View
      style={[
        styles.row,
        item.unread && styles.rowUnread,
        active && styles.rowActive,
        selected && styles.rowSelected,
      ]}>
      {selectable ? (
        <Pressable
          onPress={() => {
            haptics.tapLight();
            onToggleSelect();
          }}
          hitSlop={10}
          accessibilityRole="checkbox"
          accessibilityState={{ checked: selected }}
          accessibilityLabel={selected ? 'Deselect conversation' : 'Select conversation'}
          style={styles.side}>
          <Ionicons
            name={selected ? 'checkbox' : 'square-outline'}
            size={20}
            color={selected ? hubColors.crm.fg : colors.borderStrong}
          />
        </Pressable>
      ) : null}
      <Pressable
        onPress={() => {
          haptics.tapLight();
          onToggleStar();
        }}
        hitSlop={10}
        accessibilityRole="button"
        accessibilityLabel={item.starred ? 'Unstar' : 'Star'}
        style={styles.side}>
        <Ionicons
          name={item.starred ? 'star' : 'star-outline'}
          size={18}
          color={item.starred ? colors.amber : colors.borderStrong}
        />
      </Pressable>
      <Pressable
        onPress={onPress}
        onLongPress={onLongPress}
        delayLongPress={350}
        accessibilityRole="button"
        style={({ pressed }) => [styles.main, pressed && styles.pressed]}>
        <View style={styles.titleLine}>
          <Text style={[styles.who, item.unread && styles.strong]} numberOfLines={1}>
            {item.isDraft ? <Text style={styles.draftTag}>Draft · </Text> : null}
            {who}
          </Text>
          {item.messageCount > 1 ? <Text style={styles.count}>{item.messageCount}</Text> : null}
          {item.hasAttachments ? <Ionicons name="attach" size={14} color={colors.inkSoft} /> : null}
          <Text style={[styles.time, item.unread && styles.timeUnread]}>{relativeTime(item.date)}</Text>
        </View>
        <Text style={[styles.subject, item.unread && styles.strong]} numberOfLines={1}>
          {item.subject}
        </Text>
        <Text style={styles.snippet} numberOfLines={1}>
          {item.snippet || '—'}
        </Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.surfaceAlt,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.line,
    paddingLeft: spacing.xs,
  },
  rowUnread: { backgroundColor: colors.white },
  rowActive: { backgroundColor: hubColors.crm.bg },
  rowSelected: { backgroundColor: colors.skySoft },
  side: { width: 32, height: 44, alignItems: 'center', justifyContent: 'center' },
  main: { flex: 1, paddingVertical: spacing.sm + 2, paddingRight: spacing.md, gap: 1 },
  pressed: { opacity: 0.7 },
  titleLine: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs },
  who: { flex: 1, color: colors.inkSoft, fontSize: 14, fontWeight: '600' },
  strong: { color: colors.ink, fontWeight: '800' },
  draftTag: { color: colors.danger, fontWeight: '800' },
  count: { color: colors.textMuted, fontSize: 11, fontWeight: '800' },
  time: { color: colors.textMuted, fontSize: 11, fontWeight: '700' },
  timeUnread: { color: hubColors.crm.fg },
  subject: { color: colors.ink, fontSize: 14, fontWeight: '600' },
  snippet: { color: colors.textMuted, fontSize: 13, fontWeight: '500' },
});
