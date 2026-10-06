import { StyleSheet, Text, View } from 'react-native';

import { colors, spacing } from '@/constants/theme';

/**
 * Renders a sales resource's light markup (2026-10-07) — what admins type in
 * CRM Settings → Sales resources:
 *   "# Heading"      a step heading
 *   "## Subheading"  a smaller heading
 *   "- bullet"       a bullet line
 *   anything else    a paragraph; a blank line starts a new one
 * Big, plain text: it is read on a phone, often mid-call.
 */
export function ResourceText({ body, compact = false }: { body: string | null; compact?: boolean }) {
  if (!body?.trim()) return <Text style={styles.empty}>Nothing here yet.</Text>;
  const blocks: { type: 'h1' | 'h2' | 'bullet' | 'p'; text: string }[] = [];
  let para: string[] = [];
  const flush = () => {
    if (para.length) blocks.push({ type: 'p', text: para.join(' ') });
    para = [];
  };
  for (const raw of body.split('\n')) {
    const line = raw.trim();
    if (!line) {
      flush();
    } else if (line.startsWith('## ')) {
      flush();
      blocks.push({ type: 'h2', text: line.slice(3) });
    } else if (line.startsWith('# ')) {
      flush();
      blocks.push({ type: 'h1', text: line.slice(2) });
    } else if (/^[-•*] /.test(line)) {
      flush();
      blocks.push({ type: 'bullet', text: line.slice(2) });
    } else {
      para.push(line);
    }
  }
  flush();

  const size = compact ? 15 : 17;
  return (
    <View style={styles.wrap}>
      {blocks.map((b, i) =>
        b.type === 'h1' ? (
          <Text key={i} style={[styles.h1, i > 0 && styles.gapTop]}>
            {b.text}
          </Text>
        ) : b.type === 'h2' ? (
          <Text key={i} style={[styles.h2, i > 0 && styles.gapTop]}>
            {b.text}
          </Text>
        ) : b.type === 'bullet' ? (
          <View key={i} style={styles.bulletRow}>
            <Text style={[styles.bulletDot, { fontSize: size }]}>•</Text>
            <Text style={[styles.body, { fontSize: size, lineHeight: size * 1.4 }]}>{b.text}</Text>
          </View>
        ) : (
          <Text key={i} style={[styles.body, { fontSize: size, lineHeight: size * 1.4 }]}>
            {b.text}
          </Text>
        ),
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { gap: spacing.xs },
  h1: { color: colors.ink, fontSize: 19, fontWeight: '800' },
  h2: { color: colors.ink, fontSize: 16, fontWeight: '800' },
  gapTop: { marginTop: spacing.md },
  bulletRow: { flexDirection: 'row', gap: spacing.sm, paddingLeft: 2 },
  bulletDot: { color: colors.inkSoft },
  body: { flex: 1, color: colors.ink, fontWeight: '500' },
  empty: { color: colors.inkSoft, fontSize: 14 },
});
