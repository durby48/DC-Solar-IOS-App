import { useFocusEffect } from 'expo-router';
import { useCallback, useState } from 'react';

import { RecentCallsList } from '@/components/phone/RecentCallsList';
import { markCallsSeen, openDialer } from '@/lib/dialerWindow';

/**
 * `/recents` — Recent calls (2026-10-07, rep Settings → Recent calls). The
 * list is components/phone/RecentCallsList, shared with the keypad window's
 * Recents tab (2026-10-09). Looking here clears the keypad button's
 * missed-call badge; an unknown caller opens the keypad window with their
 * number filled in.
 */
export default function RecentsScreen() {
  const [reloadKey, setReloadKey] = useState(0);
  useFocusEffect(
    useCallback(() => {
      setReloadKey((k) => k + 1);
      void markCallsSeen();
    }, []),
  );
  return <RecentCallsList reloadKey={reloadKey} onDialUnknown={(phone) => openDialer({ phone })} />;
}
