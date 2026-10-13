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
 *
 * Merge fields (2026-10-12): with `fields`, "{{first_name}}" and friends are
 * filled in for the person on the call (lib/callScript.ts) and drawn
 * highlighted; a field with no value shows as a highlighted blank so the rep
 * fills it out loud. A line that is nothing but empty fields is skipped.
 * Without `fields` (the Resources screens) a field shows as "[first name]".
 */
type Fields = Record<string, string | null>;
const TOKEN = /\{\{\s*([a-z_]+)\s*\}\}/g;

function isOnlyEmptyFields(line: string, fields: Fields | undefined): boolean {
  if (!fields || !line.includes('{{')) return false;
  const tokens = [...line.matchAll(TOKEN)].map((m) => m[1]);
  return line.replace(TOKEN, '').trim() === '' && tokens.every((t) => !fields[t]?.trim());
}

function Filled({ text, fields, style }: { text: string; fields?: Fields; style: object }) {
  const parts: React.ReactNode[] = [];
  let last = 0;
  for (const m of text.matchAll(TOKEN)) {
    const at = m.index ?? 0;
    if (at > last) parts.push(text.slice(last, at));
    const name = m[1];
    const value = fields?.[name]?.trim();
    parts.push(
      fields ? (
        <Text key={at} style={value ? styles.filled : styles.blank}>
          {value || ' _______ '}
        </Text>
      ) : (
        <Text key={at} style={styles.placeholder}>
          [{name.replace(/_/g, ' ')}]
        </Text>
      ),
    );
    last = at + m[0].length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return <Text style={style}>{parts}</Text>;
}

export function ResourceText({ body, compact = false, fields }: { body: string | null; compact?: boolean; fields?: Fields }) {
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
      if (!isOnlyEmptyFields(line.slice(2), fields)) blocks.push({ type: 'bullet', text: line.slice(2) });
    } else if (!isOnlyEmptyFields(line, fields)) {
      para.push(line);
    }
  }
  flush();

  const size = compact ? 15 : 17;
  const bodyStyle = [styles.body, { fontSize: size, lineHeight: size * 1.4 }];
  return (
    <View style={styles.wrap}>
      {blocks.map((b, i) =>
        b.type === 'h1' ? (
          <Filled key={i} text={b.text} fields={fields} style={[styles.h1, i > 0 && styles.gapTop]} />
        ) : b.type === 'h2' ? (
          <Filled key={i} text={b.text} fields={fields} style={[styles.h2, i > 0 && styles.gapTop]} />
        ) : b.type === 'bullet' ? (
          <View key={i} style={styles.bulletRow}>
            <Text style={[styles.bulletDot, { fontSize: size }]}>•</Text>
            <Filled text={b.text} fields={fields} style={bodyStyle} />
          </View>
        ) : (
          <Filled key={i} text={b.text} fields={fields} style={bodyStyle} />
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
  // Filled for this person: the brand's sun, bold, so the rep's eye finds it.
  filled: { color: colors.sun, fontWeight: '800', backgroundColor: colors.amberSoft },
  // Unknown: a coral blank the rep fills out loud.
  blank: { color: colors.coralDeep, fontWeight: '800', textDecorationLine: 'underline' },
  placeholder: { color: colors.inkSoft, fontWeight: '700' },
});
