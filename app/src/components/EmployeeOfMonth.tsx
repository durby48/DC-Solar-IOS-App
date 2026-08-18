import Ionicons from '@expo/vector-icons/Ionicons';
import { Image } from 'expo-image';
import { useCallback, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { useFocusEffect } from 'expo-router';

import { accentCycle, colors, radii, shadows, spacing } from '@/constants/theme';
import { fetchEmployeeOfMonth, type EmployeeOfMonthCard } from '@/lib/eom';

/**
 * Employee of the Month card for the Today screen — visible to EVERY role,
 * crew included. That's the point: it's a bit of company recognition, not an
 * admin report, and it carries nothing but a name, a photo and a caption.
 *
 * Renders NOTHING when there is no card to show (table not migrated yet, RLS
 * denied, no rows at all). `fetchEmployeeOfMonth` never throws, so the worst
 * case here is an absent card, never a broken Today screen.
 *
 * The month in the eyebrow is always the CURRENT month even when the row shown
 * is an older one — see lib/eom.ts for why the fallback exists.
 */
export function EmployeeOfMonth() {
  const [card, setCard] = useState<EmployeeOfMonthCard | null>(null);

  // Refetch on focus so an admin who just added this month's photo sees it
  // when they come back to Today, matching how the rest of the screen reloads.
  useFocusEffect(
    useCallback(() => {
      let cancelled = false;
      fetchEmployeeOfMonth().then((next) => {
        if (!cancelled) setCard(next);
      });
      return () => {
        cancelled = true;
      };
    }, []),
  );

  if (!card) return null;

  const initials = card.employeeName
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? '')
    .join('');

  // Stable tint per person, same trick CustomerAvatar uses.
  const hash = [...card.employeeEmail].reduce(
    (acc, ch) => (acc * 31 + ch.charCodeAt(0)) >>> 0,
    7,
  );
  const accent = accentCycle[hash % accentCycle.length];

  return (
    <View style={styles.card}>
      {card.photoUrl ? (
        <Image
          source={{ uri: card.photoUrl }}
          style={styles.photo}
          contentFit="cover"
          cachePolicy="memory-disk"
          transition={150}
        />
      ) : (
        <View style={[styles.photo, styles.photoFallback, { backgroundColor: accent.bg }]}>
          <Text style={[styles.initials, { color: accent.fg }]}>{initials || '?'}</Text>
        </View>
      )}

      <View style={styles.body}>
        <View style={styles.eyebrowRow}>
          <View style={styles.trophy}>
            <Ionicons name="trophy" size={12} color={colors.amberDeep} />
          </View>
          <Text style={styles.eyebrow} numberOfLines={1}>
            Employee of the Month · {card.label}
          </Text>
        </View>
        <Text style={styles.name} numberOfLines={2}>
          {card.employeeName}
        </Text>
        {card.caption ? (
          <Text style={styles.caption} numberOfLines={3}>
            {card.caption}
          </Text>
        ) : null}
      </View>
    </View>
  );
}

const PHOTO_SIZE = 76;

const styles = StyleSheet.create({
  card: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    backgroundColor: colors.white,
    borderRadius: radii.md,
    padding: spacing.md,
    marginTop: spacing.md,
    ...shadows.card,
  },
  photo: {
    width: PHOTO_SIZE,
    height: PHOTO_SIZE,
    borderRadius: radii.md,
    backgroundColor: colors.amberSoft,
  },
  photoFallback: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  initials: {
    fontSize: PHOTO_SIZE * 0.36,
    fontWeight: '800',
  },
  body: {
    flex: 1,
    gap: 2,
  },
  eyebrowRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs + 2,
  },
  trophy: {
    width: 22,
    height: 22,
    borderRadius: radii.pill,
    backgroundColor: colors.amberSoft,
    alignItems: 'center',
    justifyContent: 'center',
  },
  eyebrow: {
    flex: 1,
    color: colors.amberDeep,
    fontSize: 11,
    fontWeight: '800',
    textTransform: 'uppercase',
    letterSpacing: 0.4,
  },
  name: {
    color: colors.ink,
    fontSize: 20,
    fontWeight: '800',
  },
  caption: {
    color: colors.inkSoft,
    fontSize: 13,
    fontWeight: '600',
    lineHeight: 18,
  },
});
