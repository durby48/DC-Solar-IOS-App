import Ionicons from '@expo/vector-icons/Ionicons';
import { router } from 'expo-router';
import { useEffect, useState, type ReactNode } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { SafeAreaInsetsContext, useSafeAreaInsets } from 'react-native-safe-area-context';

import { colors } from '@/constants/theme';
import { leaveDevView } from '@/lib/devView';
import {
  getDevView,
  ROLE_LABELS,
  subscribeDevNotice,
  subscribeDevView,
  type DevNotice,
} from '@/lib/devViewState';

/**
 * The bar a developer sees across the top of every screen while viewing as
 * someone (2026-10-08): who, which role, look-only or not, and one tap back.
 * A "could they?" answer from a save/text/call shows under it for a few
 * seconds. Tapping the name opens Developer Tools.
 *
 * It sits IN the layout, above the app, rather than floating over it — a
 * floating bar covered the text box at the bottom of a conversation. The bar
 * takes the status-bar inset itself, so the app below it gets a top inset of
 * 0 (no double gap). The tree is the same shape with or without a view, so
 * the navigator under it never remounts when the saved view loads.
 */
export function DevViewFrame({ children }: { children: ReactNode }) {
  const insets = useSafeAreaInsets();
  const [view, setView] = useState(getDevView());
  const [notice, setNotice] = useState<DevNotice | null>(null);
  const [leaving, setLeaving] = useState(false);
  const [barHeight, setBarHeight] = useState(0);

  useEffect(() => subscribeDevView(() => setView(getDevView())), []);
  useEffect(() => subscribeDevNotice(setNotice), []);
  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(() => setNotice((cur) => (cur?.id === notice.id ? null : cur)), 7000);
    return () => clearTimeout(t);
  }, [notice]);

  const title = !view
    ? ''
    : view.kind === 'person'
      ? `Viewing as ${view.name} · ${ROLE_LABELS[view.role] ?? view.role}`
      : `Screens as ${ROLE_LABELS[view.role] ?? view.role}`;
  const sub = view?.kind === 'person' ? 'Look-only — nothing is saved or sent' : 'Your own data — actions are real';

  return (
    <View style={styles.root}>
      {view ? (
        <View
          style={[styles.bar, { paddingTop: insets.top + 6 }]}
          onLayout={(e) => setBarHeight(e.nativeEvent.layout.height)}>
          <Pressable
            onPress={() => router.push('/dev-tools' as never)}
            style={({ pressed }) => [styles.who, pressed && styles.pressed]}
            accessibilityRole="button"
            accessibilityLabel="Open Developer Tools">
            <Ionicons name={view.kind === 'person' ? 'eye' : 'color-wand'} size={16} color={colors.sun} />
            <View style={styles.textCol}>
              <Text style={styles.title} numberOfLines={1}>
                {title}
              </Text>
              <Text style={styles.sub} numberOfLines={1}>
                {sub}
              </Text>
            </View>
          </Pressable>
          <Pressable
            disabled={leaving}
            onPress={() => {
              setLeaving(true);
              void leaveDevView();
            }}
            style={({ pressed }) => [styles.back, (pressed || leaving) && styles.pressed]}
            accessibilityRole="button">
            <Text style={styles.backText}>{leaving ? 'Leaving…' : 'Back to my view'}</Text>
          </Pressable>
        </View>
      ) : null}
      <SafeAreaInsetsContext.Provider value={view ? { ...insets, top: 0 } : insets}>
        <View style={styles.root}>{children}</View>
      </SafeAreaInsetsContext.Provider>
      {view && notice ? (
        <View pointerEvents="none" style={[styles.noticeLayer, { top: barHeight + 6 }]}>
          <View style={[styles.notice, notice.ok ? styles.noticeOk : styles.noticeNo]}>
            <Ionicons name={notice.ok ? 'checkmark-circle' : 'close-circle'} size={16} color="#fff" />
            <Text style={styles.noticeText}>{notice.text}</Text>
          </View>
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  bar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    backgroundColor: '#14161A',
    borderBottomWidth: 2,
    borderBottomColor: colors.sun,
    paddingLeft: 14,
    paddingRight: 8,
    paddingBottom: 6,
  },
  who: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 8, minWidth: 0 },
  textCol: { flex: 1, minWidth: 0 },
  title: { color: '#fff', fontSize: 13, fontWeight: '800' },
  sub: { color: 'rgba(255,255,255,0.7)', fontSize: 11, fontWeight: '600' },
  back: { backgroundColor: colors.sun, borderRadius: 999, paddingHorizontal: 12, paddingVertical: 7 },
  backText: { color: colors.textOnAction, fontSize: 12, fontWeight: '800' },
  pressed: { opacity: 0.6 },
  noticeLayer: { position: 'absolute', left: 12, right: 12, alignItems: 'center', zIndex: 200 },
  notice: {
    width: '100%',
    maxWidth: 520,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    borderRadius: 12,
    paddingHorizontal: 12,
    paddingVertical: 9,
    shadowColor: '#000',
    shadowOpacity: 0.3,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 3 },
    elevation: 6,
  },
  noticeOk: { backgroundColor: '#1F7A4D' },
  noticeNo: { backgroundColor: '#B3261E' },
  noticeText: { flex: 1, color: '#fff', fontSize: 12, fontWeight: '700' },
});
