import Ionicons from '@expo/vector-icons/Ionicons';
import { useRouter } from 'expo-router';
import { Linking, Pressable, StyleSheet, View } from 'react-native';

import { CustomerAvatar } from '@/components/CustomerAvatar';
import { AppText, Card, ListRow, SectionHeader } from '@/components/ui';
import { colors, hubColors, radii, spacing } from '@/constants/theme';
import { type Customer } from '@/lib/types';

function open(url: string) {
  Linking.openURL(url).catch(() => {});
}

/**
 * The customer block on a job (2026-09-12, job → customer cross-link).
 *
 * Same rows as `CustomerCard` — phone, email, address, each opening its own
 * `tel:` / `mailto:` / Maps URL — but the name-and-avatar line is a tap
 * target that opens the customer record (`/crm/[id]`), with a "View
 * customer" affordance in the CRM hub's purple so it reads as a link into
 * that hub rather than as a heading. `CustomerCard` stays for callers that
 * only have a `Customer` and nowhere to go; this one needs the id the job
 * row carries.
 */
export function JobCustomerCard({ customer }: { customer: Customer }) {
  const router = useRouter();
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

  const openRecord = () => router.push({ pathname: '/crm/[id]', params: { id: customer.id } });

  return (
    <>
      <SectionHeader title="Customer" icon="person" style={styles.section} />
      <Card padded={false}>
        <Pressable
          onPress={openRecord}
          accessibilityRole="button"
          accessibilityLabel={`View customer ${customer.name}`}
          style={({ pressed }) => [
            styles.nameRow,
            rows.length > 0 && styles.nameRowDivider,
            pressed && styles.pressed,
          ]}>
          <CustomerAvatar customer={customer} size={40} />
          <View style={styles.nameBody}>
            <AppText variant="heading" numberOfLines={1}>
              {customer.name}
            </AppText>
            <View style={styles.viewRow}>
              <AppText variant="caption" color={hubColors.crm.fg}>
                View customer
              </AppText>
              <Ionicons name="chevron-forward" size={12} color={hubColors.crm.fg} />
            </View>
          </View>
          <View style={styles.crmBadge}>
            <Ionicons name="people" size={16} color={hubColors.crm.fg} />
          </View>
        </Pressable>
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
  nameBody: {
    flex: 1,
    gap: 2,
  },
  viewRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 2,
  },
  crmBadge: {
    width: 32,
    height: 32,
    borderRadius: radii.sm,
    backgroundColor: hubColors.crm.bg,
    alignItems: 'center',
    justifyContent: 'center',
  },
  pressed: {
    opacity: 0.7,
  },
});
