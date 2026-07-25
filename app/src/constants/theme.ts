/**
 * DC Solar KC brand theme — soft, sunny, rounded.
 * All colors/spacing/radii live here; screens should not hardcode hex values.
 */

export const colors = {
  cream: '#FFF3E6',
  sun: '#FFB066',
  sunLight: '#FFD3A6',
  ocean: '#5AA8CF',
  sky: '#9FD6F2',
  skySoft: '#DCEFFB',
  tan: '#ECD9BE',
  ink: '#3D352E',
  inkSoft: '#6B5D4F',
  white: '#FFFFFF',
  card: '#FFFFFF',
  danger: '#C0564A',
} as const;

export const spacing = {
  xs: 4,
  sm: 8,
  md: 16,
  lg: 24,
  xl: 32,
  xxl: 48,
} as const;

export const radii = {
  sm: 10,
  md: 16,
  lg: 24,
  pill: 999,
} as const;

export const shadows = {
  card: {
    shadowColor: colors.ink,
    shadowOpacity: 0.08,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 4 },
    elevation: 3,
  },
} as const;

export type JobStatus = 'active' | 'completed' | 'on_hold';

export const statusColors: Record<JobStatus, { bg: string; text: string; label: string }> = {
  active: { bg: colors.skySoft, text: colors.ocean, label: 'Active' },
  completed: { bg: colors.tan, text: colors.inkSoft, label: 'Completed' },
  on_hold: { bg: colors.sunLight, text: colors.ink, label: 'On hold' },
};
