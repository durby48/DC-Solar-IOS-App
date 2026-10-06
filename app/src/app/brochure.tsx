import Ionicons from '@expo/vector-icons/Ionicons';
import { Image } from 'expo-image';
import { Stack, useLocalSearchParams } from 'expo-router';
import { useEffect, useState } from 'react';
import { Linking, Platform, Pressable, ScrollView, StyleSheet, Text, View, useWindowDimensions } from 'react-native';

import { fetchPublicPlans, fetchRepContact, type PublicPlan } from '@/lib/brochure';
import { formatPhone } from '@/lib/comms';
import { COMPANY_PHONE } from '@/lib/company';

/**
 * `/brochure` — the customer brochure (2026-10-07). PUBLIC: a customer opens
 * it from a rep's text without signing in. `?rep=<slug>` puts that rep's name
 * and DC Solar number on it (public_rep_contact); without it, the company
 * number. Plans come from public_service_plans(), so prices and "what's
 * included" update with CRM Settings → Service plans.
 *
 * Deliberately LIGHT and bright (not the app's dark palette): it is marketing
 * for customers. On a computer, "Save as PDF" prints it — the same content as
 * a printable brochure for email or leaving behind.
 *
 * Claims are kept to what is true today; the "About" copy and photos are
 * placeholders until Carson and Devon supply them.
 */
const INK = '#1F2A33';
const SOFT = '#5C6B77';
const SUN = '#F2A93B';
const SKY = '#EAF3FA';
const LINE = '#D5DDE3';
const WARM = '#FFF6E8';
const TIER_TINT: Record<string, string> = { bronze: '#B87333', silver: '#8A97A3', gold: '#C9A227' };

function dollars(cents: number): string {
  return `$${(cents / 100).toLocaleString('en-US', { minimumFractionDigits: cents % 100 ? 2 : 0 })}`;
}

export default function BrochurePage() {
  const { rep } = useLocalSearchParams<{ rep?: string }>();
  const { width } = useWindowDimensions();
  const wide = width >= 820;
  const [plans, setPlans] = useState<PublicPlan[]>([]);
  const [contact, setContact] = useState<{ name: string; phone: string | null } | null>(null);

  useEffect(() => {
    void fetchPublicPlans().then(setPlans);
    if (typeof rep === 'string' && rep) void fetchRepContact(rep).then(setContact);
  }, [rep]);

  const phone = contact?.phone ? formatPhone(contact.phone) : COMPANY_PHONE;
  const digits = (contact?.phone ?? COMPANY_PHONE).replace(/[^0-9+]/g, '');
  const firstName = contact?.name?.split(' ')[0];

  return (
    <View style={styles.page}>
      <Stack.Screen options={{ title: 'DC Solar service plans', headerShown: false }} />
      <ScrollView contentContainerStyle={styles.scroll}>
        <View style={styles.hero}>
          <Image source={require('@/assets/images/login-solarflow.jpg')} style={StyleSheet.absoluteFill} contentFit="cover" />
          <View style={styles.heroShade} />
          <View style={[styles.inner, styles.heroInner]}>
            {/* The logo stays black (brand), on a light plate so it reads on the photo. */}
            <View style={styles.logoPlate}>
              <Image source={require('@/assets/images/logo.png')} style={styles.logo} contentFit="contain" />
            </View>
            <Text style={styles.heroTitle}>Keep your solar working like day one.</Text>
            <Text style={styles.heroSub}>Yearly solar service from your local Kansas City team.</Text>
          </View>
        </View>

        <View style={styles.inner}>
          <View style={[styles.contact, wide && styles.row]}>
            <View style={styles.flex}>
              <Text style={styles.contactLabel}>{contact ? 'Your DC Solar contact' : 'Questions? Call or text us'}</Text>
              <Text style={styles.contactName}>{contact?.name ?? 'DC Solar'}</Text>
              <Text style={styles.contactPhone}>{phone}</Text>
            </View>
            <View style={[styles.contactButtons, !wide && styles.contactButtonsNarrow]}>
              <Pressable onPress={() => void Linking.openURL(`tel:${digits}`)} style={styles.primary}>
                <Ionicons name="call" size={16} color="#fff" />
                <Text style={styles.primaryText}>Call{firstName ? ` ${firstName}` : ''}</Text>
              </Pressable>
              <Pressable onPress={() => void Linking.openURL(`sms:${digits}`)} style={styles.secondary}>
                <Ionicons name="chatbubble" size={16} color={INK} />
                <Text style={styles.secondaryText}>Text</Text>
              </Pressable>
            </View>
          </View>

          <Text style={styles.h2}>Why service matters</Text>
          <View style={[styles.grid, wide && styles.row]}>
            {[
              ['sunny', 'Dirt cuts output', 'Dust, pollen, bird droppings and debris build up on panels and lower how much power they make.'],
              ['construct', 'Small problems hide', 'A loose connection or a failing inverter can go unnoticed for months while the system underproduces.'],
              ['shield-checkmark', 'Protect your investment', 'A yearly check keeps the system you paid for working the way it should.'],
            ].map(([icon, title, body]) => (
              <View key={title} style={[styles.tile, wide && styles.flex]}>
                <Ionicons name={icon as 'sunny'} size={22} color={SUN} />
                <Text style={styles.tileTitle}>{title}</Text>
                <Text style={styles.tileBody}>{body}</Text>
              </View>
            ))}
          </View>

          <Text style={styles.h2}>What we do on a visit</Text>
          <View style={styles.list}>
            {['Inspect the panels, mounting and wiring', 'Clean the panels', 'Check the inverter and your monitoring', 'Send you a report on what we found'].map((t) => (
              <View key={t} style={styles.listRow}>
                <Ionicons name="checkmark-circle" size={18} color="#3E9B5B" />
                <Text style={styles.listText}>{t}</Text>
              </View>
            ))}
          </View>

          <Text style={styles.h2}>Plans</Text>
          <View style={[styles.grid, wide && styles.row]}>
            {plans.map((p) => (
              <View key={p.tier} style={[styles.plan, { borderTopColor: TIER_TINT[p.tier] ?? SUN }, wide && styles.flex]}>
                <Text style={[styles.planName, { color: TIER_TINT[p.tier] ?? INK }]}>{p.label}</Text>
                <Text style={styles.planPrice}>
                  {dollars(p.amountCents)}
                  <Text style={styles.planPer}> / year</Text>
                </Text>
                {(p.includes ?? '')
                  .split('\n')
                  .map((l) => l.trim().replace(/^[-•✓]\s*/, ''))
                  .filter(Boolean)
                  .map((l) => (
                    <View key={l} style={styles.listRow}>
                      <Ionicons name="checkmark" size={16} color="#3E9B5B" />
                      <Text style={styles.listText}>{l}</Text>
                    </View>
                  ))}
                {!p.includes ? <Text style={styles.tileBody}>Ask us what&apos;s included.</Text> : null}
              </View>
            ))}
          </View>

          <Text style={styles.h2}>How it works</Text>
          <View style={styles.list}>
            {[
              'Pick a plan and book your first visit.',
              'Save a card securely — nothing is charged until after your first visit.',
              'Your plan renews yearly, with a 2-year agreement.',
            ].map((t, i) => (
              <View key={t} style={styles.listRow}>
                <Text style={styles.step}>{i + 1}</Text>
                <Text style={styles.listText}>{t}</Text>
              </View>
            ))}
          </View>

          <Text style={styles.h2}>About DC Solar</Text>
          <Text style={styles.about}>
            DC Solar is a local Kansas City solar team. We install and take care of solar systems for homes and businesses
            around KC.
          </Text>

          {Platform.OS === 'web' ? (
            <Pressable
              onPress={() => (globalThis as unknown as { print?: () => void }).print?.()}
              style={[styles.secondary, styles.printButton]}
              accessibilityLabel="Save as PDF">
              <Ionicons name="download-outline" size={16} color={INK} />
              <Text style={styles.secondaryText}>Save as PDF</Text>
            </Pressable>
          ) : null}
          <Text style={styles.footer}>DC Solar · Kansas City · {phone}</Text>
        </View>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: '#FFFFFF' },
  scroll: { paddingBottom: 40 },
  inner: { width: '100%', maxWidth: 960, alignSelf: 'center', paddingHorizontal: 22, gap: 16 },
  hero: { height: 340, justifyContent: 'flex-end', overflow: 'hidden' },
  heroShade: { position: 'absolute', top: 0, right: 0, bottom: 0, left: 0, backgroundColor: 'rgba(10,20,30,0.55)' },
  heroInner: { paddingBottom: 56, gap: 12 },
  logoPlate: {
    alignSelf: 'flex-start',
    backgroundColor: 'rgba(255,255,255,0.94)',
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: 8,
    marginBottom: 4,
  },
  logo: { width: 150, height: 40 },
  heroTitle: { color: '#fff', fontSize: 30, fontWeight: '800', lineHeight: 36 },
  heroSub: { color: 'rgba(255,255,255,0.92)', fontSize: 16, fontWeight: '500', lineHeight: 23 },
  // The rep's card: clearly its own block — warm fill, brand-orange border,
  // a real shadow (Carson: the first version was hard to see).
  contact: {
    marginTop: -28,
    backgroundColor: WARM,
    borderRadius: 16,
    padding: 22,
    gap: 18,
    borderWidth: 2,
    borderColor: SUN,
    shadowColor: '#000',
    shadowOpacity: 0.18,
    shadowRadius: 18,
    shadowOffset: { width: 0, height: 6 },
    elevation: 6,
  },
  row: { flexDirection: 'row', alignItems: 'stretch', gap: 14 },
  flex: { flex: 1 },
  contactLabel: { color: '#B5701A', fontSize: 12, fontWeight: '800', textTransform: 'uppercase', letterSpacing: 0.6 },
  contactName: { color: INK, fontSize: 24, fontWeight: '800', marginTop: 4 },
  contactPhone: { color: INK, fontSize: 18, fontWeight: '700' },
  contactButtons: { flexDirection: 'row', gap: 12, alignItems: 'center' },
  contactButtonsNarrow: { alignSelf: 'stretch' },
  primary: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, backgroundColor: SUN, borderRadius: 999, paddingHorizontal: 20, paddingVertical: 12 },
  primaryText: { color: '#fff', fontSize: 15, fontWeight: '800' },
  secondary: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, backgroundColor: '#fff', borderWidth: 1.5, borderColor: INK, borderRadius: 999, paddingHorizontal: 20, paddingVertical: 12 },
  secondaryText: { color: INK, fontSize: 15, fontWeight: '800' },
  // Clear separation between sections, a little room under each heading.
  h2: { color: INK, fontSize: 22, fontWeight: '800', marginTop: 30, marginBottom: 2 },
  grid: { gap: 14 },
  tile: { backgroundColor: SKY, borderRadius: 14, padding: 18, gap: 8, borderWidth: 1, borderColor: '#CFE0EE' },
  tileTitle: { color: INK, fontSize: 16, fontWeight: '800' },
  tileBody: { color: SOFT, fontSize: 14, lineHeight: 21 },
  list: { gap: 12 },
  listRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 10 },
  listText: { flex: 1, color: INK, fontSize: 15, lineHeight: 21 },
  step: { width: 22, height: 22, borderRadius: 11, backgroundColor: SUN, color: '#fff', textAlign: 'center', fontWeight: '800', lineHeight: 22, overflow: 'hidden' },
  plan: {
    backgroundColor: '#fff',
    borderRadius: 12,
    borderWidth: 1.5,
    borderColor: LINE,
    borderTopWidth: 6,
    padding: 18,
    gap: 10,
    shadowColor: '#000',
    shadowOpacity: 0.08,
    shadowRadius: 10,
    shadowOffset: { width: 0, height: 3 },
    elevation: 2,
  },
  planName: { fontSize: 18, fontWeight: '800' },
  planPrice: { color: INK, fontSize: 28, fontWeight: '800' },
  planPer: { color: SOFT, fontSize: 15, fontWeight: '600' },
  about: { color: SOFT, fontSize: 15, lineHeight: 23 },
  printButton: { alignSelf: 'flex-start', marginTop: 24 },
  footer: { color: SOFT, fontSize: 12, marginTop: 28, textAlign: 'center' },
});
