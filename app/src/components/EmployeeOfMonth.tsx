import Ionicons from '@expo/vector-icons/Ionicons';
import { Image } from 'expo-image';
import { useFocusEffect } from 'expo-router';
import { useCallback, useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { AppText, FadeInUp, GradientSurface, PulseRing } from '@/components/ui';
import { colors, radii, shadows, spacing } from '@/constants/theme';
import { fetchEmployeeOfMonth, formatMonthLabel, type EmployeeOfMonthCard } from '@/lib/eom';
import { DURATION, useMotion } from '@/lib/motion';
import { useRole } from '@/lib/role';

/**
 * Employee of the Month — a trophy placard, on the Calendar screen.
 *
 * WHERE IT LIVES (2026-08-22). This used to be a small white row on Home.
 * Devon asked for it to leave the hub and live on the Calendar instead: one
 * screen you go to in order to look at the month, rather than the one you
 * open forty times a day to punch in. Home no longer mounts it at all;
 * `(tabs)/calendar.tsx` renders it directly under the screen title.
 *
 * WHAT IT IS NOW. A placard, not a list row: olive plaque, gold hairline
 * edge, a trophy medallion, and a real PHOTO FRAME — a 4:5 slot sized like a
 * printed portrait rather than a 76pt avatar. The frame is the point. Until
 * the Dropbox library is wired up there is no photo of Garrett to show, so
 * the empty state is a dashed frame that reads as "a picture goes here,
 * nobody has hung it yet" instead of a set of initials pretending to be one.
 * When `eom.ts` hands back a `photoUrl` (resolved from `photo_path`, which
 * the "From Dropbox" picker writes) the same slot fills in and nothing else
 * on the plaque moves.
 *
 * Visible to EVERY role, crew included — it is company recognition, not an
 * admin report, and it carries nothing but a name, a picture and a caption.
 * The only thing the role changes is one extra line telling an admin where to
 * go and add the photo.
 *
 * Renders NOTHING when there is no card to show (signed out, table not
 * migrated yet, RLS denied, no rows at all). `fetchEmployeeOfMonth` never
 * throws, so the worst case here is an absent placard, never a broken screen.
 *
 * The month in the eyebrow is always the CURRENT month even when the row
 * shown is an older one; `isFallback` says so in its own line rather than
 * quietly backdating the headline. See lib/eom.ts for why.
 */
export function EmployeeOfMonth() {
  const [card, setCard] = useState<EmployeeOfMonthCard | null>(null);
  const role = useRole();

  // Refetch on focus so an admin who just added this month's photo sees it
  // when they come back to the Calendar, matching how the rest of the screen
  // reloads.
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

  return <EmployeeOfMonthPlacard card={card} isAdmin={role?.isAdmin ?? false} />;
}

/**
 * The placard itself, with no data fetching in it.
 *
 * Split out from the component above so the plaque can be drawn from a fixed
 * card — a preview, a screenshot, a design review — without a session, a
 * network, or an `employee_of_month` row. `EmployeeOfMonth` is its only
 * caller inside the app.
 */
export function EmployeeOfMonthPlacard({
  card,
  isAdmin = false,
}: {
  card: EmployeeOfMonthCard;
  /** Owners and operators get the "where do I add the photo" line. */
  isAdmin?: boolean;
}) {
  const motion = useMotion();

  // One swipe stop for a screen reader: the plaque reads as a single
  // announcement rather than five fragments, which is how a sighted person
  // takes it in too.
  const a11yLabel = [
    `Employee of the Month, ${card.label}`,
    card.employeeName,
    card.caption ?? '',
    card.isFallback ? `Standing since ${formatMonthLabel(card.month)}` : '',
    card.photoUrl ? 'Photo shown' : 'Photo coming soon',
  ]
    .filter(Boolean)
    .join('. ');

  return (
    <FadeInUp>
      {/* The shadow lives out here: `GradientSurface` clips to its radius and
          iOS clips the drop shadow along with it. The olive fill underneath
          is what gives the shadow a shape to be cast by. */}
      <View
        accessible
        accessibilityRole="summary"
        accessibilityLabel={a11yLabel}
        style={styles.shell}>
        <GradientSurface gradient="olive" direction="diagonal" radius="lg" style={styles.placard}>
          <View style={styles.eyebrowRow}>
            <View style={styles.medallion}>
              {/* A gold breath on the trophy, and only when motion is on —
                  this sits on a screen people read slowly. */}
              {motion.enabled ? (
                <PulseRing color={colors.sun} radius={radii.pill} scaleTo={1.7} duration={2600} />
              ) : null}
              <Ionicons name="trophy" size={15} color={colors.oliveDeep} />
            </View>
            {/* Two engraved lines rather than one "Employee of the Month ·
                August 2026" string. Measured on a 375pt phone that string
                needs 284pt in a 257pt column, and it breaks after the month
                NAME — leaving "2026" alone on the second line. Stacking it is
                the same height, never orphans at any width, and gives the
                month the gold the plaque wants. */}
            <View style={styles.eyebrow}>
              <AppText variant="section" color={colors.textOnDark} numberOfLines={1}>
                Employee of the Month
              </AppText>
              <AppText variant="section" color={colors.sunLight} numberOfLines={1}>
                {card.label}
              </AppText>
            </View>
          </View>

          {/* The engraved line across a real plaque. */}
          <View style={styles.rule} />

          <View style={styles.row}>
            <PhotoSlot
              photoUrl={card.photoUrl}
              name={card.employeeName}
              transition={motion.ms(DURATION.base)}
            />

            <View style={styles.body}>
              <AppText variant="title" color={colors.textOnDark} numberOfLines={3}>
                {card.employeeName}
              </AppText>
              {card.caption ? (
                <AppText variant="body" color={colors.oliveSoft} numberOfLines={5}>
                  {card.caption}
                </AppText>
              ) : null}
              {card.isFallback ? (
                <AppText variant="caption" color={colors.sunLight}>
                  Still standing from {formatMonthLabel(card.month)}
                </AppText>
              ) : null}
            </View>
          </View>

          {/* Only shown to the people who can actually do something about it. */}
          {!card.photoUrl && isAdmin ? (
            <AppText variant="caption" color={colors.sunLight}>
              Add one in Menu → Employee of the Month
            </AppText>
          ) : null}
        </GradientSurface>
      </View>
    </FadeInUp>
  );
}

/**
 * The portrait slot: 4:5, the shape of a printed photo.
 *
 * Empty is a DESIGNED state, not a missing one — a dashed cream frame with an
 * images glyph, sized and positioned exactly like the filled one, so hanging
 * the real picture later moves nothing else on the plaque.
 */
function PhotoSlot({
  photoUrl,
  name,
  transition,
}: {
  photoUrl: string | null;
  name: string;
  /** Fade duration in ms, already zeroed by `useMotion` when reduced. */
  transition: number;
}) {
  if (photoUrl) {
    return (
      <View style={[styles.frame, styles.frameFilled]}>
        <Image
          source={{ uri: photoUrl }}
          style={styles.photo}
          contentFit="cover"
          cachePolicy="memory-disk"
          transition={transition}
          accessibilityLabel={`Photo of ${name}`}
        />
      </View>
    );
  }

  return (
    <View style={[styles.frame, styles.frameEmpty]}>
      <Ionicons name="images-outline" size={26} color={colors.sunLight} />
      <AppText variant="caption" color={colors.textOnDark} align="center">
        Photo coming soon
      </AppText>
    </View>
  );
}

/** 4:5 — a portrait, not an avatar. */
const FRAME_W = 120;
const FRAME_H = 150;

const styles = StyleSheet.create({
  shell: {
    borderRadius: radii.lg,
    backgroundColor: colors.olive,
    ...shadows.card,
  },
  placard: {
    padding: spacing.md,
    gap: spacing.sm,
    // The gold edge of the plaque: sunLight, held back so it reads as a bevel
    // rather than a highlighter line.
    borderWidth: 1,
    borderColor: 'rgba(255,211,166,0.45)',
  },
  eyebrowRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
  },
  medallion: {
    width: 28,
    height: 28,
    borderRadius: radii.pill,
    backgroundColor: colors.sun,
    alignItems: 'center',
    justifyContent: 'center',
  },
  eyebrow: {
    flex: 1,
  },
  rule: {
    height: 1,
    backgroundColor: colors.sunLight,
    opacity: 0.45,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: spacing.md,
  },
  frame: {
    width: FRAME_W,
    height: FRAME_H,
    borderRadius: radii.md,
    overflow: 'hidden',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.xs,
  },
  frameFilled: {
    borderWidth: 2,
    borderColor: colors.sunLight,
    backgroundColor: colors.oliveDeep,
  },
  frameEmpty: {
    borderWidth: 1.5,
    borderStyle: 'dashed',
    borderColor: 'rgba(255,243,230,0.55)',
    backgroundColor: 'rgba(255,243,230,0.08)',
    paddingHorizontal: spacing.sm,
  },
  photo: {
    width: '100%',
    height: '100%',
  },
  body: {
    flex: 1,
    gap: spacing.xs,
  },
});
