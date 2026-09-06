import Ionicons from '@expo/vector-icons/Ionicons';
import * as Clipboard from 'expo-clipboard';
import { useState } from 'react';
import { ActivityIndicator, Platform, Pressable, StyleSheet, Text, View } from 'react-native';

import { colors, fonts, radii, spacing } from '@/constants/theme';

/**
 * The keypad: 3×4, letters under the digits, long-press 0 for +, backspace,
 * paste, and the call button.
 *
 * Pure input. It owns nothing but the touch targets — the screen above it
 * owns the number, decides whether calling is possible right now, and shows
 * who the number already belongs to. That split is what lets the same pad
 * dial a customer with their record attached and a stranger with none.
 *
 * FORMATS AS YOU TYPE, DIALS WHAT YOU TYPED. The display groups a US number
 * the way people read one; `value` stays raw digits (plus an optional leading
 * +) so nothing about the formatting can end up in the Twilio request.
 *
 * `expo-clipboard` for paste — already in the build as of 29, and the web
 * implementation falls back to `navigator.clipboard`, which browsers gate
 * behind a user gesture; the paste button IS that gesture.
 */

const KEYS: readonly { digit: string; letters: string }[] = [
  { digit: '1', letters: '' },
  { digit: '2', letters: 'ABC' },
  { digit: '3', letters: 'DEF' },
  { digit: '4', letters: 'GHI' },
  { digit: '5', letters: 'JKL' },
  { digit: '6', letters: 'MNO' },
  { digit: '7', letters: 'PQRS' },
  { digit: '8', letters: 'TUV' },
  { digit: '9', letters: 'WXYZ' },
  { digit: '*', letters: '' },
  { digit: '0', letters: '+' },
  { digit: '#', letters: '' },
];

/** Keep only what a dialler can send: digits, and a single leading +. */
export function sanitizeDialed(raw: string): string {
  const cleaned = raw.replace(/[^0-9+*#]/g, '');
  const plus = cleaned.startsWith('+') ? '+' : '';
  return plus + cleaned.replace(/\+/g, '');
}

/**
 * "8167446473" → "(816) 744-6473", partial input grouped the same way, and a
 * +1 number shown with its country code. Anything that is not a US shape is
 * shown as typed — a mangled pretty-printer is worse than raw digits.
 */
export function formatDialed(value: string): string {
  if (!value) return '';
  const plus = value.startsWith('+');
  let digits = value.replace(/[^0-9]/g, '');
  let prefix = '';
  if (plus && digits.startsWith('1')) {
    prefix = '+1 ';
    digits = digits.slice(1);
  } else if (plus) {
    return value;
  } else if (digits.length === 11 && digits.startsWith('1')) {
    prefix = '1 ';
    digits = digits.slice(1);
  }
  if (/[*#]/.test(value)) return value;
  if (digits.length > 10) return prefix + digits;
  const a = digits.slice(0, 3);
  const b = digits.slice(3, 6);
  const c = digits.slice(6, 10);
  if (digits.length <= 3) return prefix + a;
  if (digits.length <= 6) return `${prefix}(${a}) ${b}`;
  return `${prefix}(${a}) ${b}-${c}`;
}

export function Dialpad({
  value,
  onChange,
  onCall,
  callDisabled = false,
  callBusy = false,
}: {
  value: string;
  onChange: (next: string) => void;
  onCall: () => void;
  callDisabled?: boolean;
  callBusy?: boolean;
}) {
  const [pasteNote, setPasteNote] = useState<string | null>(null);

  const press = (digit: string) => {
    if (value.length >= 20) return;
    onChange(sanitizeDialed(value + digit));
  };

  const backspace = () => onChange(value.slice(0, -1));

  const paste = async () => {
    try {
      const text = await Clipboard.getStringAsync();
      const cleaned = sanitizeDialed(text ?? '');
      if (!cleaned) {
        setPasteNote('Nothing that looks like a number on the clipboard.');
        setTimeout(() => setPasteNote(null), 2500);
        return;
      }
      onChange(cleaned);
    } catch {
      setPasteNote(
        Platform.OS === 'web'
          ? 'The browser blocked clipboard access — type the number instead.'
          : 'Could not read the clipboard.',
      );
      setTimeout(() => setPasteNote(null), 2500);
    }
  };

  const canCall = !callDisabled && !callBusy && value.replace(/[^0-9]/g, '').length >= 3;

  return (
    <View style={styles.wrap}>
      <View style={styles.display}>
        <Text
          style={[styles.number, value.length === 0 && styles.numberEmpty]}
          numberOfLines={1}
          adjustsFontSizeToFit
          selectable>
          {value ? formatDialed(value) : 'Enter a number'}
        </Text>
        <View style={styles.displayActions}>
          <Pressable
            onPress={() => void paste()}
            hitSlop={8}
            accessibilityLabel="Paste number"
            style={({ pressed }) => [styles.smallButton, pressed && styles.pressed]}>
            <Ionicons name="clipboard-outline" size={18} color={colors.ocean} />
          </Pressable>
          <Pressable
            onPress={backspace}
            onLongPress={() => onChange('')}
            disabled={value.length === 0}
            hitSlop={8}
            accessibilityLabel="Delete last digit"
            style={({ pressed }) => [
              styles.smallButton,
              value.length === 0 && styles.hidden,
              pressed && styles.pressed,
            ]}>
            <Ionicons name="backspace-outline" size={20} color={colors.ink} />
          </Pressable>
        </View>
      </View>
      {pasteNote ? <Text style={styles.pasteNote}>{pasteNote}</Text> : null}

      <View style={styles.grid}>
        {KEYS.map((key) => (
          <Pressable
            key={key.digit}
            onPress={() => press(key.digit)}
            onLongPress={key.digit === '0' ? () => press('+') : undefined}
            delayLongPress={350}
            accessibilityLabel={key.digit === '0' ? '0, long press for plus' : key.digit}
            style={({ pressed }) => [styles.key, pressed && styles.keyPressed]}>
            <Text style={styles.keyDigit}>{key.digit}</Text>
            {key.letters ? <Text style={styles.keyLetters}>{key.letters}</Text> : null}
          </Pressable>
        ))}
      </View>

      <Pressable
        onPress={onCall}
        disabled={!canCall}
        accessibilityLabel="Call"
        style={({ pressed }) => [styles.callButton, !canCall && styles.callDisabled, pressed && canCall && styles.pressed]}>
        {callBusy ? (
          <ActivityIndicator color={colors.white} />
        ) : (
          <Ionicons name="call" size={28} color={colors.white} />
        )}
      </Pressable>
    </View>
  );
}

const KEY_SIZE = 72;

const styles = StyleSheet.create({
  wrap: { alignItems: 'center', gap: spacing.md },
  display: {
    width: '100%',
    minHeight: 64,
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: spacing.md,
  },
  number: {
    flex: 1,
    fontFamily: fonts.display,
    fontSize: 32,
    letterSpacing: 0.5,
    color: colors.ink,
    textAlign: 'center',
  },
  numberEmpty: { color: colors.inkSoft, fontFamily: fonts.medium, fontSize: 18 },
  displayActions: { flexDirection: 'row', gap: spacing.xs, position: 'absolute', right: spacing.md },
  smallButton: {
    width: 36,
    height: 36,
    borderRadius: radii.pill,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.white,
  },
  hidden: { opacity: 0 },
  pasteNote: { color: colors.inkSoft, fontSize: 12, fontWeight: '600', textAlign: 'center' },
  grid: {
    width: KEY_SIZE * 3 + spacing.md * 2,
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'center',
    gap: spacing.md,
  },
  key: {
    width: KEY_SIZE,
    height: KEY_SIZE,
    borderRadius: KEY_SIZE / 2,
    backgroundColor: colors.white,
    alignItems: 'center',
    justifyContent: 'center',
  },
  keyPressed: { backgroundColor: colors.skySoft },
  keyDigit: { fontFamily: fonts.display, fontSize: 28, color: colors.ink, lineHeight: 32 },
  keyLetters: { fontFamily: fonts.bold, fontSize: 10, letterSpacing: 1.5, color: colors.inkSoft },
  callButton: {
    width: KEY_SIZE,
    height: KEY_SIZE,
    borderRadius: KEY_SIZE / 2,
    backgroundColor: colors.success,
    alignItems: 'center',
    justifyContent: 'center',
  },
  callDisabled: { backgroundColor: colors.slateSoft },
  pressed: { opacity: 0.6 },
});
