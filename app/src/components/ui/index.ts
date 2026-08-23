/**
 * The DC Solar KC UI kit.
 *
 *   import { Screen, Card, AppText, Button } from '@/components/ui';
 *
 * Everything here is pure React Native + the tokens in `constants/theme`, and
 * everything here works on app.dcsolarkc.com as well as on a phone. Two rules
 * hold across the whole directory:
 *
 *   1. Every primitive takes `style` and spreads it LAST, so a call site can
 *      always override without forking the component.
 *   2. Motion goes through `useMotion()` from `lib/motion` — one reduced-
 *      motion gate for the whole app.
 *
 * Files inside this folder import each other by RELATIVE path, never through
 * this barrel, so there's no import cycle.
 */

// Type & layout
export { AppText } from './AppText';
export { Screen } from './Screen';
export { Card, type CardElevation, type CardTone } from './Card';
export { SectionHeader } from './SectionHeader';
export { GradientSurface, ScrimDown } from './GradientSurface';

// Controls
export { Button, type ButtonSize, type ButtonVariant } from './Button';
export { Chip, type ChipTone } from './Chip';
export { Pill } from './Pill';
export { ListRow } from './ListRow';
export { WheelPicker, WheelPickerSheet, type WheelOption } from './WheelPicker';

// Data display
export { Tile, type TileTone } from './Tile';
export { StatTile, type StatTone } from './StatTile';
export { EmptyState } from './EmptyState';
export { Skeleton, SkeletonList } from './Skeleton';

// Motion
export { AnimatedPressable } from './AnimatedPressable';
export { FadeInUp } from './FadeInUp';
export { CountUp, type CountUpProps } from './CountUp';
export { Confetti } from './Confetti';
export { TabIcon, type TabIconName } from './TabIcon';
export { PulseRing } from './PulseRing';
