import { StyleSheet, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { CrmWorkspace } from '@/components/crm/workspace/CrmWorkspace';
import { colors } from '@/constants/theme';

/**
 * The CRM tab (web-first, 2026-09-07).
 *
 * The file is `workspace.tsx`, not `crm.tsx`, because `/crm` is already a
 * route — `app/crm/index.tsx` redirects it to the Customers tab and
 * `crm/[id]`, `crm/inbox`, `crm/settings` live under it — and two files
 * claiming one URL is exactly the ambiguity that produced the sign-out
 * redirect loop on `/`. The tab is LABELLED "CRM"; its URL is `/workspace`.
 *
 * Nothing but a shell: the screen is `components/crm/workspace/CrmWorkspace`,
 * which owns its own gate and layouts. No page padding — the workspace is
 * edge-to-edge columns.
 */
export default function CrmTab() {
  return (
    <SafeAreaView edges={['top']} style={styles.screen}>
      <View style={styles.screen}>
        <CrmWorkspace />
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.cream },
});
