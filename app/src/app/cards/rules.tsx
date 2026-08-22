import Ionicons from '@expo/vector-icons/Ionicons';
import { Stack, useFocusEffect } from 'expo-router';
import { Fragment, useCallback, useMemo, useState } from 'react';
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';

import { AppText, Card, EmptyState, Screen } from '@/components/ui';
import { colors, fonts, radii, spacing } from '@/constants/theme';
import { fetchCardSet, type CardSet } from '@/lib/cards';
import { supabase } from '@/lib/supabase';

/**
 * The rules of the game, rendered from `card_sets.rules_md`.
 *
 * The rules live in the database rather than the bundle so a house rule can be
 * corrected over the air; the trade-off is that the app has to render
 * Markdown, and there is no Markdown library in this project. Adding one for a
 * single 90-line document would be a dependency, a licence and an OTA payload
 * for something the parser below does in a hundred lines.
 *
 * It handles exactly what RULES.md uses — headings, paragraphs, bullet and
 * numbered lists, one pipe table, horizontal rules, and inline bold / italic /
 * code — and degrades to plain paragraphs for anything else. It is a renderer
 * for a known document, not a Markdown implementation; if the rules ever grow
 * a nested list or a code fence, extend `parseBlocks` rather than pretending
 * this is CommonMark.
 */
export default function CardRulesScreen() {
  const [set, setSet] = useState<CardSet | null>(null);
  const [state, setState] = useState<'loading' | 'ok' | 'empty'>('loading');
  const [signedIn, setSignedIn] = useState<boolean | null>(null);

  useFocusEffect(
    useCallback(() => {
      let cancelled = false;
      const run = async () => {
        const { data } = await supabase.auth.getSession();
        if (cancelled) return;
        const authed = Boolean(data.session?.user?.email);
        setSignedIn(authed);
        if (!authed) return;

        const row = await fetchCardSet();
        if (cancelled) return;
        setSet(row);
        setState(row?.rules_md?.trim() ? 'ok' : 'empty');
      };
      void run();
      return () => {
        cancelled = true;
      };
    }, []),
  );

  const blocks = useMemo(() => parseBlocks(set?.rules_md ?? ''), [set?.rules_md]);

  if (signedIn === false) {
    return (
      <>
        <Stack.Screen options={{ title: 'Rules' }} />
        <Screen edges={[]}>
          <Card style={styles.center}>
            <View style={styles.badge}>
              <Ionicons name="book" size={26} color={colors.accentPrimary} />
            </View>
            <AppText variant="heading" align="center">
              Sign in to read the rules
            </AppText>
            <AppText variant="body" color={colors.textMuted} align="center">
              The rules ship with the card set, which is only visible to signed-in crew members.
            </AppText>
          </Card>
        </Screen>
      </>
    );
  }

  return (
    <>
      <Stack.Screen options={{ title: 'Rules' }} />
      <Screen edges={[]}>
        {signedIn === null || state === 'loading' ? (
          <View style={styles.center}>
            <ActivityIndicator color={colors.accentPrimary} />
          </View>
        ) : state === 'empty' ? (
          <EmptyState
            icon="book-outline"
            title="No rules on file"
            body="This set was imported without its rules document. The cards still work; the arguing is on you."
          />
        ) : (
          <Card style={styles.sheet}>
            {blocks.map((block, index) => (
              <Block key={index} block={block} />
            ))}
            {set?.version ? (
              <AppText variant="caption" color={colors.textMuted} style={styles.version}>
                {set.name} · v{set.version}
                {set.generated_on ? ` · ${set.generated_on}` : ''}
              </AppText>
            ) : null}
          </Card>
        )}
      </Screen>
    </>
  );
}

// ---------------------------------------------------------------------------
// Blocks
// ---------------------------------------------------------------------------

type MdBlock =
  | { kind: 'heading'; level: 1 | 2 | 3; text: string }
  | { kind: 'paragraph'; text: string }
  | { kind: 'bullets'; items: string[]; indented: boolean }
  | { kind: 'ordered'; items: string[]; start: number }
  | { kind: 'table'; header: string[]; rows: string[][] }
  | { kind: 'rule' };

/** Splits a Markdown document into the handful of blocks RULES.md contains. */
function parseBlocks(markdown: string): MdBlock[] {
  const lines = markdown.replace(/\r\n/g, '\n').split('\n');
  const blocks: MdBlock[] = [];
  let paragraph: string[] = [];

  const flushParagraph = () => {
    if (paragraph.length > 0) {
      blocks.push({ kind: 'paragraph', text: paragraph.join(' ').trim() });
      paragraph = [];
    }
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    if (trimmed.length === 0) {
      flushParagraph();
      continue;
    }

    // --- horizontal rule ---
    if (/^(-{3,}|\*{3,}|_{3,})$/.test(trimmed)) {
      flushParagraph();
      blocks.push({ kind: 'rule' });
      continue;
    }

    // --- heading ---
    const heading = /^(#{1,6})\s+(.*)$/.exec(trimmed);
    if (heading) {
      flushParagraph();
      const level = Math.min(3, heading[1].length) as 1 | 2 | 3;
      blocks.push({ kind: 'heading', level, text: heading[2].trim() });
      continue;
    }

    // --- table: consecutive lines that start and end with a pipe ---
    if (trimmed.startsWith('|')) {
      flushParagraph();
      const raw: string[] = [];
      while (i < lines.length && lines[i].trim().startsWith('|')) {
        raw.push(lines[i].trim());
        i++;
      }
      i--;
      const cells = raw
        .map((row) =>
          row
            .replace(/^\|/, '')
            .replace(/\|$/, '')
            .split('|')
            .map((cell) => cell.trim()),
        )
        // Drop the |---|---| alignment row: it is punctuation, not data.
        .filter((row) => !row.every((cell) => /^:?-{2,}:?$/.test(cell)));
      if (cells.length > 0) {
        blocks.push({ kind: 'table', header: cells[0], rows: cells.slice(1) });
      }
      continue;
    }

    // --- bullets ---
    // `indented` carries the sub-bullets nested under step 3 of "On Your
    // Turn". They are a separate block rather than part of the step, and the
    // indent is what keeps them reading as belonging to it.
    if (/^[-*+]\s+/.test(trimmed)) {
      flushParagraph();
      const indented = /^\s{2,}/.test(line);
      const items: string[] = [];
      while (i < lines.length && /^[-*+]\s+/.test(lines[i].trim())) {
        items.push(lines[i].trim().replace(/^[-*+]\s+/, ''));
        i++;
      }
      i--;
      blocks.push({ kind: 'bullets', items, indented });
      continue;
    }

    // --- numbered ---
    // The FIRST NUMBER IS KEPT, not assumed to be 1. RULES.md interrupts its
    // "On Your Turn" list with sub-bullets after step 3, which ends the block;
    // without this, step 4 ("Pass") renders as step 1 and the turn order reads
    // as nonsense.
    if (/^\d+[.)]\s+/.test(trimmed)) {
      flushParagraph();
      const start = Number(/^(\d+)/.exec(trimmed)?.[1] ?? '1');
      const items: string[] = [];
      while (i < lines.length && /^\d+[.)]\s+/.test(lines[i].trim())) {
        items.push(lines[i].trim().replace(/^\d+[.)]\s+/, ''));
        i++;
      }
      i--;
      blocks.push({ kind: 'ordered', items, start: Number.isFinite(start) ? start : 1 });
      continue;
    }

    paragraph.push(trimmed);
  }

  flushParagraph();
  return blocks;
}

function Block({ block }: { block: MdBlock }) {
  switch (block.kind) {
    case 'heading':
      return (
        <AppText
          variant={block.level === 1 ? 'title' : block.level === 2 ? 'heading' : 'bodyStrong'}
          color={block.level === 3 ? colors.textPrimary : colors.accentPrimary}
          style={block.level === 1 ? styles.h1 : styles.h2}>
          <Inline text={block.text} />
        </AppText>
      );

    case 'paragraph':
      return (
        <AppText variant="body" color={colors.textSecondary} style={styles.paragraph}>
          <Inline text={block.text} />
        </AppText>
      );

    case 'bullets':
      return (
        <View style={[styles.list, block.indented && styles.nested]}>
          {block.items.map((item, index) => (
            <View key={index} style={styles.listItem}>
              <AppText variant="body" color={colors.oliveMid}>
                •
              </AppText>
              <AppText variant="body" color={colors.textSecondary} style={styles.listText}>
                <Inline text={item} />
              </AppText>
            </View>
          ))}
        </View>
      );

    case 'ordered':
      return (
        <View style={styles.list}>
          {block.items.map((item, index) => (
            <View key={index} style={styles.listItem}>
              <AppText variant="bodyStrong" color={colors.accentPrimary} style={styles.ordinal}>
                {block.start + index}.
              </AppText>
              <AppText variant="body" color={colors.textSecondary} style={styles.listText}>
                <Inline text={item} />
              </AppText>
            </View>
          ))}
        </View>
      );

    case 'table':
      return (
        <View style={styles.table}>
          <View style={[styles.tableRow, styles.tableHead]}>
            {block.header.map((cell, index) => (
              <AppText
                key={index}
                variant="caption"
                color={colors.textOnDark}
                style={styles.tableCell}>
                <Inline text={cell} />
              </AppText>
            ))}
          </View>
          {block.rows.map((row, rowIndex) => (
            <View
              key={rowIndex}
              style={[styles.tableRow, rowIndex % 2 === 1 ? styles.tableAlt : null]}>
              {row.map((cell, index) => (
                <AppText
                  key={index}
                  variant="caption"
                  color={colors.textSecondary}
                  style={styles.tableCell}>
                  <Inline text={cell} />
                </AppText>
              ))}
            </View>
          ))}
        </View>
      );

    case 'rule':
      return <View style={styles.hr} />;

    default:
      return null;
  }
}

/**
 * Inline `**bold**`, `*italic*` and `` `code` ``.
 *
 * One split on an alternation, then every odd chunk is a marked-up run. Bold
 * swaps to the Inter 600 face rather than setting `fontWeight`, because a
 * weight on top of a named face is what makes iOS synthesise a smeared bold —
 * the rule the whole theme is built on.
 */
function Inline({ text }: { text: string }) {
  const parts = text.split(/(\*\*[^*]+\*\*|\*[^*]+\*|`[^`]+`)/g).filter((part) => part.length > 0);
  return (
    <>
      {parts.map((part, index) => {
        if (part.startsWith('**') && part.endsWith('**') && part.length > 4) {
          return (
            <Text key={index} style={styles.bold}>
              {part.slice(2, -2)}
            </Text>
          );
        }
        if (part.startsWith('*') && part.endsWith('*') && part.length > 2) {
          return (
            <Text key={index} style={styles.italic}>
              {part.slice(1, -1)}
            </Text>
          );
        }
        if (part.startsWith('`') && part.endsWith('`') && part.length > 2) {
          return (
            <Text key={index} style={styles.code}>
              {part.slice(1, -1)}
            </Text>
          );
        }
        return <Fragment key={index}>{part}</Fragment>;
      })}
    </>
  );
}

const styles = StyleSheet.create({
  center: {
    alignItems: 'center',
    gap: spacing.sm,
    paddingVertical: spacing.xl,
  },
  badge: {
    width: 56,
    height: 56,
    borderRadius: radii.pill,
    backgroundColor: colors.oliveTint,
    alignItems: 'center',
    justifyContent: 'center',
  },
  sheet: {
    gap: spacing.xs,
  },
  h1: {
    marginBottom: spacing.xs,
  },
  h2: {
    marginTop: spacing.md,
    marginBottom: spacing.xs,
  },
  paragraph: {
    marginBottom: spacing.xs,
  },
  list: {
    gap: spacing.xs,
    marginBottom: spacing.sm,
  },
  listItem: {
    flexDirection: 'row',
    gap: spacing.sm,
    alignItems: 'flex-start',
  },
  nested: {
    marginLeft: spacing.md,
  },
  ordinal: {
    minWidth: 18,
  },
  listText: {
    flex: 1,
  },
  table: {
    borderRadius: radii.sm,
    overflow: 'hidden',
    marginVertical: spacing.sm,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
  },
  tableRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: spacing.sm,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs + 2,
  },
  tableHead: {
    backgroundColor: colors.accentPrimary,
  },
  tableAlt: {
    backgroundColor: colors.oliveTint,
  },
  tableCell: {
    flex: 1,
  },
  hr: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: colors.border,
    marginVertical: spacing.md,
  },
  bold: {
    fontFamily: fonts.semibold,
    color: colors.textPrimary,
  },
  italic: {
    fontStyle: 'italic',
  },
  code: {
    fontFamily: fonts.medium,
    color: colors.oliveDeep,
  },
  version: {
    marginTop: spacing.lg,
  },
});
