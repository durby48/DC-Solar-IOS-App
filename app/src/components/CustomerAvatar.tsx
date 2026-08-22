import { Image } from 'expo-image';
import { useEffect, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { accentCycle, colors } from '@/constants/theme';
import { getCustomerPhotoUrl } from '@/lib/customers';
import { type Customer } from '@/lib/types';

/**
 * Small round customer photo with an initials fallback.
 *
 * Sizing is fully automatic: the caller passes one `size` and the circle,
 * radius and font all derive from it, so the same component works at 26px on
 * a pipeline card and at 96px on the customer detail screen.
 *
 * The photo lives in the private job-photos bucket, so the URL has to be
 * signed — that's async, hence the internal state. Falls back to initials on
 * any failure rather than showing a broken image.
 *
 * A LIST SHOULD PASS `url`. Signing per instance means one storage request per
 * rendered avatar, which is fine for the one avatar on a job screen and
 * miserable for a CRM list. Callers rendering many at once should batch with
 * `fetchCustomerAvatarUrls()` (`lib/crm.ts`) and hand the signed URL in — this
 * component then skips its own signing entirely.
 */
export function CustomerAvatar({
  customer,
  size = 40,
  url: signedUrl,
}: {
  customer: Pick<Customer, 'id' | 'name'> & { photo_path?: string | null };
  size?: number;
  /** Pre-signed URL from a batched `createSignedUrls` call. */
  url?: string | null;
}) {
  const [ownUrl, setOwnUrl] = useState<string | null>(null);
  const path = customer.photo_path ?? null;
  // `undefined` = the caller isn't batching, so sign it ourselves. `null` =
  // the caller batched and this customer has no usable photo — don't retry.
  const batched = signedUrl !== undefined;

  useEffect(() => {
    let cancelled = false;
    if (!path || batched) {
      setOwnUrl(null);
      return;
    }
    getCustomerPhotoUrl(path).then((signed) => {
      if (!cancelled) setOwnUrl(signed);
    });
    return () => {
      cancelled = true;
    };
  }, [path, batched]);

  const url = batched ? (signedUrl ?? null) : ownUrl;

  const initials = (customer.name ?? '?')
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? '')
    .join('');

  // Stable colour per customer so the same person always gets the same tint.
  const hash = [...(customer.id ?? customer.name ?? '')].reduce(
    (acc, ch) => (acc * 31 + ch.charCodeAt(0)) >>> 0,
    7,
  );
  const accent = accentCycle[hash % accentCycle.length];

  const box = {
    width: size,
    height: size,
    borderRadius: size / 2,
  };

  if (url) {
    return (
      <Image
        source={{ uri: url }}
        style={[box, styles.image]}
        contentFit="cover"
        cachePolicy="memory-disk"
        transition={150}
      />
    );
  }

  return (
    <View style={[box, styles.fallback, { backgroundColor: accent.bg }]}>
      <Text style={[styles.initials, { color: accent.fg, fontSize: size * 0.4 }]}>
        {initials || '?'}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  image: {
    backgroundColor: colors.skySoft,
  },
  fallback: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  initials: {
    fontWeight: '800',
  },
});
