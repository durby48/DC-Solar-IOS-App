import Ionicons from '@expo/vector-icons/Ionicons';
import { Stack, useFocusEffect, useRouter } from 'expo-router';
import { useCallback, useMemo, useState } from 'react';
import { FlatList, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import { CustomerAvatar } from '@/components/CustomerAvatar';
import { colors, radii, shadows, spacing } from '@/constants/theme';
import {
  fetchDirectory,
  formatPhone,
  matchDirectory,
  type DirectoryEntry,
} from '@/lib/comms';

/**
 * `/messages/compose` — "New Message". A To: field, and as you type it
 * offers everyone in the directory whose name or number matches, or the
 * bare number you typed. Picking one opens the conversation with the
 * composer focused, which is where the text gets written — the same as a
 * phone, where the recipient picker is not where you type the message.
 */

const SOURCE_LABEL: Record<DirectoryEntry['source'], string> = {
  customer: 'Customer',
  lead: 'Lead',
  crew: 'Crew',
  contact: 'Supplier',
};

function toE164(raw: string): string | null {
  const trimmed = raw.trim();
  if (/^\+[1-9]\d{7,14}$/.test(trimmed)) return trimmed;
  const digits = trimmed.replace(/[^0-9]/g, '');
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  return null;
}

type Row =
  | { kind: 'entry'; entry: DirectoryEntry }
  | { kind: 'number'; phone: string };

export default function ComposeScreen() {
  const router = useRouter();
  const [query, setQuery] = useState('');
  const [directory, setDirectory] = useState<DirectoryEntry[]>([]);

  useFocusEffect(
    useCallback(() => {
      let cancelled = false;
      void fetchDirectory().then((rows) => {
        if (!cancelled) setDirectory(rows);
      });
      return () => {
        cancelled = true;
      };
    }, []),
  );

  const rows = useMemo<Row[]>(() => {
    const q = query.trim();
    const out: Row[] = [];
    if (!q) {
      // Nothing typed: the whole directory, the people with a number first.
      for (const entry of directory) {
        if (!entry.archived && entry.phoneE164) out.push({ kind: 'entry', entry });
      }
      return out;
    }
    const lower = q.toLowerCase();
    const digits = q.replace(/[^0-9]/g, '');
    const seen = new Set<string>();
    const push = (entry: DirectoryEntry) => {
      const key = `${entry.source}:${entry.id}`;
      if (seen.has(key) || entry.archived || !entry.phoneE164) return;
      seen.add(key);
      out.push({ kind: 'entry', entry });
    };
    if (digits.length >= 4) matchDirectory(directory, q, 8).forEach(push);
    if (/[a-z]/i.test(q)) {
      for (const entry of directory) {
        if (
          entry.displayName.toLowerCase().includes(lower) ||
          entry.subtitle?.toLowerCase().includes(lower)
        ) {
          push(entry);
        }
      }
    }
    const typed = toE164(q);
    if (typed && !out.some((r) => r.kind === 'entry' && r.entry.phoneE164 === typed)) {
      out.push({ kind: 'number', phone: typed });
    }
    return out;
  }, [directory, query]);

  const open = (row: Row) => {
    if (row.kind === 'number') {
      router.replace({
        pathname: '/messages/thread',
        params: { phone: row.phone, name: formatPhone(row.phone) },
      } as never);
      return;
    }
    const { entry } = row;
    const params: Record<string, string> = { name: entry.displayName };
    if (entry.phoneE164) params.phone = entry.phoneE164;
    if (entry.source === 'customer') params.customerId = entry.id;
    else if (entry.source === 'contact') params.contactId = entry.id;
    else if (entry.source === 'lead') params.leadId = entry.id;
    router.replace({ pathname: '/messages/thread', params } as never);
  };

  const renderRow = ({ item }: { item: Row }) => {
    if (item.kind === 'number') {
      return (
        <Pressable onPress={() => open(item)} style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}>
          <View style={styles.numberIcon}>
            <Ionicons name="keypad" size={16} color={colors.ocean} />
          </View>
          <View style={styles.rowBody}>
            <Text style={styles.rowName}>Text {formatPhone(item.phone)}</Text>
            <Text style={styles.rowMeta}>Not in the directory — a new conversation</Text>
          </View>
          <Ionicons name="chevron-forward" size={16} color={colors.inkSoft} />
        </Pressable>
      );
    }
    const { entry } = item;
    return (
      <Pressable onPress={() => open(item)} style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}>
        <CustomerAvatar customer={{ id: entry.id, name: entry.displayName }} size={36} url={null} />
        <View style={styles.rowBody}>
          <Text style={styles.rowName} numberOfLines={1}>
            {entry.displayName}
          </Text>
          <Text style={styles.rowMeta} numberOfLines={1}>
            {SOURCE_LABEL[entry.source]}
            {entry.subtitle ? ` · ${entry.subtitle}` : ''}
            {entry.phoneE164 ? ` · ${formatPhone(entry.phoneE164)}` : ''}
          </Text>
        </View>
        <Ionicons name="chevron-forward" size={16} color={colors.inkSoft} />
      </Pressable>
    );
  };

  return (
    <>
      <Stack.Screen options={{ title: 'New Message' }} />
      <View style={styles.screen}>
        <View style={styles.toRow}>
          <Text style={styles.toLabel}>To:</Text>
          <TextInput
            value={query}
            onChangeText={setQuery}
            placeholder="Name or number"
            placeholderTextColor={colors.inkSoft}
            autoFocus
            autoCapitalize="words"
            autoCorrect={false}
            keyboardType="default"
            style={styles.toInput}
          />
          {query ? (
            <Pressable onPress={() => setQuery('')} hitSlop={8} accessibilityLabel="Clear">
              <Ionicons name="close-circle" size={18} color={colors.inkSoft} />
            </Pressable>
          ) : null}
        </View>
        <FlatList
          data={rows}
          keyExtractor={(row) => (row.kind === 'number' ? `num:${row.phone}` : `${row.entry.source}:${row.entry.id}`)}
          renderItem={renderRow}
          contentContainerStyle={styles.list}
          ItemSeparatorComponent={() => <View style={styles.separator} />}
          keyboardShouldPersistTaps="handled"
          ListEmptyComponent={
            <Text style={styles.empty}>
              {query.trim()
                ? 'Nobody matches — type a full number to text someone new.'
                : 'Type a name, or a number to text someone who is not in the directory yet.'}
            </Text>
          }
        />
      </View>
    </>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.cream },
  toRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    backgroundColor: colors.white,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm + 2,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.tan,
  },
  toLabel: { color: colors.inkSoft, fontSize: 15, fontWeight: '700' },
  toInput: { flex: 1, color: colors.ink, fontSize: 16, fontWeight: '500', paddingVertical: 6 },
  list: { padding: spacing.lg, paddingBottom: spacing.xxl },
  separator: { height: spacing.sm },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    backgroundColor: colors.white,
    borderRadius: radii.md,
    padding: spacing.md,
    ...shadows.card,
  },
  rowPressed: { backgroundColor: colors.skySoft },
  numberIcon: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: colors.skySoft,
    alignItems: 'center',
    justifyContent: 'center',
  },
  rowBody: { flex: 1, gap: 1 },
  rowName: { color: colors.ink, fontSize: 15, fontWeight: '700' },
  rowMeta: { color: colors.inkSoft, fontSize: 12, fontWeight: '600' },
  empty: { color: colors.inkSoft, fontSize: 13, fontWeight: '600', textAlign: 'center', paddingTop: spacing.lg },
});
