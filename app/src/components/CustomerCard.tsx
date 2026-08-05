import Ionicons from '@expo/vector-icons/Ionicons';
import { Linking, Pressable, StyleSheet, Text, View } from 'react-native';

import { CustomerAvatar } from '@/components/CustomerAvatar';
import { colors, radii, shadows, spacing } from '@/constants/theme';
import { type Customer } from '@/lib/mockData';

function open(url: string) {
  Linking.openURL(url).catch(() => {});
}

/**
 * Customer contact card: name plus tappable phone / email / address rows.
 * Parent hides it entirely when the job has no customer.
 */
export function CustomerCard({ customer }: { customer: Customer }) {
  const rows: {
    key: string;
    icon: keyof typeof Ionicons.glyphMap;
    label: string;
    value: string;
    onPress: () => void;
  }[] = [];

  if (customer.phone) {
    const phone = customer.phone;
    rows.push({
      key: 'phone',
      icon: 'call',
      label: 'Phone',
      value: phone,
      onPress: () => open('tel:' + phone.replace(/[^+\d]/g, '')),
    });
  }
  if (customer.email) {
    const email = customer.email;
    rows.push({
      key: 'email',
      icon: 'mail',
      label: 'Email',
      value: email,
      onPress: () => open('mailto:' + email),
    });
  }
  if (customer.address) {
    const address = customer.address;
    rows.push({
      key: 'address',
      icon: 'home',
      label: 'Address',
      value: address,
      onPress: () => open('https://maps.apple.com/?daddr=' + encodeURIComponent(address)),
    });
  }

  return (
    <>
      <Text style={styles.sectionTitle}>Customer</Text>
      <View style={styles.card}>
        <View style={styles.nameRow}>
          <CustomerAvatar customer={customer} size={40} />
          <Text style={styles.name}>{customer.name}</Text>
        </View>
        {rows.map((row) => (
          <Pressable
            key={row.key}
            onPress={row.onPress}
            style={({ pressed }) => [styles.row, styles.rowBorderTop, pressed && styles.rowPressed]}>
            <View style={styles.iconWrap}>
              <Ionicons name={row.icon} size={18} color={colors.ocean} />
            </View>
            <View style={styles.rowBody}>
              <Text style={styles.rowLabel}>{row.label}</Text>
              <Text style={styles.rowValue}>{row.value}</Text>
            </View>
            <Ionicons name="chevron-forward" size={18} color={colors.inkSoft} />
          </Pressable>
        ))}
      </View>
    </>
  );
}

const styles = StyleSheet.create({
  sectionTitle: {
    color: colors.ink,
    fontSize: 18,
    fontWeight: '700',
    marginTop: spacing.sm,
  },
  card: {
    backgroundColor: colors.white,
    borderRadius: radii.md,
    overflow: 'hidden',
    ...shadows.card,
  },
  nameRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    padding: spacing.md,
  },
  name: {
    color: colors.ink,
    fontSize: 16,
    fontWeight: '800',
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    padding: spacing.md,
  },
  rowBorderTop: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.tan,
  },
  rowPressed: {
    backgroundColor: colors.skySoft,
  },
  iconWrap: {
    width: 32,
    height: 32,
    borderRadius: radii.sm,
    backgroundColor: colors.skySoft,
    alignItems: 'center',
    justifyContent: 'center',
  },
  rowBody: {
    flex: 1,
    gap: 2,
  },
  rowLabel: {
    color: colors.inkSoft,
    fontSize: 12,
    fontWeight: '700',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  rowValue: {
    color: colors.ink,
    fontSize: 15,
    fontWeight: '600',
  },
});
