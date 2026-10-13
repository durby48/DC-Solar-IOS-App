import AsyncStorage from '@react-native-async-storage/async-storage';
import Ionicons from '@expo/vector-icons/Ionicons';
import { Image } from 'expo-image';
import { useRouter } from 'expo-router';
import { useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Switch, Text, View } from 'react-native';

import { ResourceText } from '@/components/resources/ResourceText';
import { colors, hubColors, radii, spacing } from '@/constants/theme';
import { scriptFieldsFor, scriptPersonOf, type ScriptFields } from '@/lib/callScript';
import { type WorkspaceRecord } from '@/lib/crmWorkspace';
import { fetchArtUrls, TIER_ART, type ArtKey } from '@/lib/marketingArt';
import { useRole } from '@/lib/role';
import { fetchResources } from '@/lib/salesResources';

/**
 * The call script in the CRM's right column (2026-10-12, Devon): one switch
 * at the top of the panel shows or hides it, and it is filled in for the
 * record that is open — "Hey Sarah, … hit by that storm on Tuesday, August
 * 19th?" (lib/callScript.ts). The switch is remembered on the device and
 * defaults to ON for sales, OFF for everyone else. The words come from CRM
 * Settings → Sales resources (kind 'script'); the pictures from the
 * marketing-art function.
 */

const STORE_KEY = 'dc.crmScript.v1';
let remembered: boolean | null = null;
let scriptCache: { at: number; body: string | null } | null = null;

async function loadScript(): Promise<string | null> {
  if (scriptCache && Date.now() - scriptCache.at < 5 * 60 * 1000) return scriptCache.body;
  const items = await fetchResources();
  const body = items.find((r) => r.kind === 'script')?.body ?? null;
  scriptCache = { at: Date.now(), body };
  return body;
}

const TIERS = ['bronze', 'silver', 'gold'] as const;

export function ScriptPanel({ record }: { record: WorkspaceRecord }) {
  const router = useRouter();
  const role = useRole();
  const [on, setOn] = useState<boolean | null>(remembered);
  const [body, setBody] = useState<string | null | undefined>(undefined);
  const [fields, setFields] = useState<ScriptFields | null>(null);
  const [art, setArt] = useState<Partial<Record<ArtKey, string>>>({});

  // The remembered switch; until it loads, sales see it on.
  useEffect(() => {
    if (remembered !== null || !role) return;
    void AsyncStorage.getItem(STORE_KEY)
      .then((v) => {
        remembered = v === null ? role.isSales : v === '1';
        setOn(remembered);
      })
      .catch(() => setOn(role.isSales));
  }, [role]);

  const toggle = (next: boolean) => {
    remembered = next;
    setOn(next);
    void AsyncStorage.setItem(STORE_KEY, next ? '1' : '0').catch(() => undefined);
  };

  useEffect(() => {
    if (!on) return;
    if (body === undefined) void loadScript().then(setBody);
    void fetchArtUrls(['script-hero', ...TIERS.map((t) => TIER_ART[t])], 640).then(setArt);
  }, [on, body]);

  const person = scriptPersonOf(record);
  const personKey = `${record.key}|${person.name}|${person.address}|${person.last_hail_at}`;
  useEffect(() => {
    if (!on) return;
    let live = true;
    setFields(null);
    void scriptFieldsFor(person, role?.displayName ?? null).then((f) => {
      if (live) setFields(f);
    });
    return () => {
      live = false;
    };
    // personKey stands in for `person`, which is rebuilt every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [on, personKey, role?.displayName]);

  return (
    <View style={[styles.section, on && styles.sectionOn]}>
      <Pressable
        onPress={() => toggle(!on)}
        accessibilityRole="switch"
        accessibilityState={{ checked: !!on }}
        accessibilityLabel="Call script"
        style={styles.head}>
        <Ionicons name="document-text" size={15} color={on ? colors.sun : colors.inkSoft} />
        <Text style={styles.title}>Call script</Text>
        <Switch
          value={!!on}
          onValueChange={toggle}
          trackColor={{ false: colors.line, true: colors.sun }}
          thumbColor={colors.surface}
          // The row itself toggles; the switch is the visible state.
          accessibilityElementsHidden
          importantForAccessibility="no"
        />
      </Pressable>

      {on ? (
        <View style={styles.body}>
          {art['script-hero'] ? (
            <Image source={{ uri: art['script-hero'] }} style={styles.hero} contentFit="cover" transition={150} />
          ) : null}
          {body === undefined || fields === null ? (
            <ActivityIndicator color={hubColors.crm.fg} style={styles.loading} />
          ) : (
            <ResourceText body={body} compact fields={fields} />
          )}

          <Pressable
            onPress={() => router.push('/plans' as never)}
            accessibilityRole="link"
            accessibilityLabel="Solar Shield plans and prices"
            style={({ pressed }) => [styles.shield, pressed && styles.pressed]}>
            <View style={styles.shieldHead}>
              <Text style={styles.shieldTitle}>Solar Shield · powered by DC Solar</Text>
              <Ionicons name="chevron-forward" size={14} color={hubColors.crm.fg} />
            </View>
            <View style={styles.tiers}>
              {TIERS.map((t) =>
                art[TIER_ART[t]] ? (
                  <Image key={t} source={{ uri: art[TIER_ART[t]] }} style={styles.tier} contentFit="cover" transition={150} />
                ) : null,
              )}
            </View>
            <Text style={styles.shieldHint}>Plans & prices</Text>
          </Pressable>
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  section: { backgroundColor: colors.surface, borderRadius: radii.md, padding: spacing.md, borderWidth: 1, borderColor: 'transparent' },
  sectionOn: { borderColor: colors.amberSoft },
  head: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs },
  title: { flex: 1, color: colors.inkSoft, fontSize: 11, fontWeight: '800', letterSpacing: 0.6, textTransform: 'uppercase' },
  body: { gap: spacing.md, marginTop: spacing.sm },
  hero: { width: '100%', aspectRatio: 16 / 9, borderRadius: radii.sm, backgroundColor: colors.canvas },
  loading: { marginVertical: spacing.md },
  shield: { gap: spacing.sm, backgroundColor: colors.canvas, borderRadius: radii.sm, padding: spacing.sm },
  shieldHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  shieldTitle: { color: colors.ink, fontSize: 13, fontWeight: '800' },
  tiers: { flexDirection: 'row', gap: spacing.xs },
  tier: { flex: 1, aspectRatio: 4 / 5, borderRadius: radii.sm, backgroundColor: colors.surface },
  shieldHint: { color: hubColors.crm.fg, fontSize: 12, fontWeight: '700' },
  pressed: { opacity: 0.6 },
});
