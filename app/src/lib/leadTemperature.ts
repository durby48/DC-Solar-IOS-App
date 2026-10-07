import type Ionicons from '@expo/vector-icons/Ionicons';

import { colors } from '@/constants/theme';

/**
 * Lead temperature (2026-10-08): Hot / Warm / Cold, a one-tap tag on a lead,
 * separate from its stage (a lead can be Contacted and Warm). Stored in
 * `leads.temperature` (2026-10-08_lead_temperature.sql); null = not set.
 */
export type LeadTemperature = 'hot' | 'warm' | 'cold';

export const TEMPERATURES: LeadTemperature[] = ['hot', 'warm', 'cold'];

export const TEMPERATURE_META: Record<
  LeadTemperature,
  { label: string; icon: keyof typeof Ionicons.glyphMap; color: string }
> = {
  hot: { label: 'Hot', icon: 'flame', color: colors.coral },
  warm: { label: 'Warm', icon: 'sunny', color: colors.amberDeep },
  cold: { label: 'Cold', icon: 'snow', color: colors.ocean },
};
