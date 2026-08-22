import Ionicons from '@expo/vector-icons/Ionicons';
import { Linking, StyleSheet, View } from 'react-native';

import { CustomerAvatar } from '@/components/CustomerAvatar';
import { AppText, Card, ListRow, SectionHeader } from '@/components/ui';
import { colors, spacing } from '@/constants/theme';
import { type Customer } from '@/lib/types';

function open(url: string) {
  Linking.openURL(url).catch(() => {});
}

/**
 * Customer contact card: name plus tappable phone / email / address rows.
 * Parent hides it entirely when the job has no customer.
 *
 * 2026-08-22 restyle: the rows are `ListRow`s now, which puts the VALUE on
 * the title line and the label ("Phone") underneath — the old layout led with
 * a shouty uppercase label and buried the number you actually want to read.
 * Every row still opens the same `tel:` / `mailto:` / Maps URL.
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
      <SectionHeader title="Customer" icon="person" style={styles.section} />
      <Card padded={false}>
        <View style={[styles.nameRow, rows.length > 0 && styles.nameRowDivider]}>
          <CustomerAvatar customer={customer} size={40} />
          <AppText variant="heading">{customer.name}</AppText>
        </View>
        {rows.map((row, index) => (
          <ListRow
            key={row.key}
            icon={row.icon}
            title={row.value}
            subtitle={row.label}
            onPress={row.onPress}
            divider={index < rows.length - 1}
          />
        ))}
      </Card>
    </>
  );
}

const styles = StyleSheet.create({
  section: {
    marginTop: spacing.sm,
  },
  nameRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    padding: spacing.md,
  },
  nameRowDivider: {
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
});
