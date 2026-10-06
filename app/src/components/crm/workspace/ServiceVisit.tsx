import Ionicons from '@expo/vector-icons/Ionicons';
import * as Clipboard from 'expo-clipboard';
import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Linking, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import { Chip } from '@/components/ui';
import { colors, radii, spacing } from '@/constants/theme';
import { sendSms } from '@/lib/comms';
import { fetchAvailability, nextWorkDays, spotsLabel, type DayAvailability } from '@/lib/availability';
import { formatShortDate } from '@/lib/dates';
import {
  fetchServicePlans,
  formatCents,
  parseDollars,
  planSummary,
  type PlanChoice,
  type ServicePlan,
} from '@/lib/servicePlans';
import {
  bookServiceVisit,
  cancelServiceVisit,
  fetchServiceVisit,
  formatVisitTime,
  requestCardLink,
  rescheduleServiceVisit,
  setServicePlan,
  SERVICE_KINDS,
  type ServiceKind,
  type ServiceVisit,
} from '@/lib/serviceVisits';

/**
 * Booking and managing a lead's service visit, inside the CRM details panel
 * (2026-10-05, B1). The database does the work and the permission checks
 * (`lib/serviceVisits.ts`); these are the forms around it.
 *
 *   BookVisitForm — type (Cleaning / Inspection), PLAN (Bronze / Silver /
 *                   Gold / Custom price — 2026-10-06), date, optional time, note.
 *   VisitCard     — what was booked and on which plan (changeable until it is
 *                   paid), Paid / Not paid, card on file, the
 *                   Stripe card link (Copy / Text / Email from the rep's own
 *                   phone or mail app), and Reschedule / Cancel while open.
 *
 * Dates use the same YYYY-MM-DD box as the appointment composer next door;
 * the quick chips are the next six work days with their visit spots left
 * (crew availability, 2026-10-06).
 */

function isoPlusDays(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return `${d.getFullYear()}-${`${d.getMonth() + 1}`.padStart(2, '0')}-${`${d.getDate()}`.padStart(2, '0')}`;
}

/**
 * Date + optional time, with crew availability (2026-10-06, S2): the next six
 * work days as chips showing visit spots left, and a status line for whatever
 * date is entered. A sales rep cannot book a Full day (the database refuses
 * it); an admin sees the same counts and may overbook on purpose.
 * `excludeJobId` leaves the visit being rescheduled out of its own count.
 */
function DateFields({
  date,
  time,
  onDate,
  onTime,
  excludeJobId,
}: {
  date: string;
  time: string;
  onDate: (v: string) => void;
  onTime: (v: string) => void;
  excludeJobId?: string;
}) {
  const [avail, setAvail] = useState<Map<string, DayAvailability> | null>(null);
  useEffect(() => {
    let cancelled = false;
    // One read covers the chips and any date typed in the next two months.
    void fetchAvailability(isoPlusDays(0), isoPlusDays(60), excludeJobId).then((m) => {
      if (!cancelled) setAvail(m);
    });
    return () => {
      cancelled = true;
    };
  }, [excludeJobId]);

  const chosen = avail?.get(date.trim());
  const dayChip = (iso: string) => {
    const d = new Date(`${iso}T12:00:00`);
    const a = avail?.get(iso);
    const name = `${d.toLocaleDateString('en-US', { weekday: 'short' })} ${d.getDate()}`;
    return a ? `${name} · ${a.spotsLeft > 0 ? `${a.spotsLeft} left` : 'Full'}` : name;
  };

  return (
    <>
      <View style={styles.chips}>
        {nextWorkDays(6).map((iso) => (
          <Chip
            key={iso}
            label={dayChip(iso)}
            tone={avail?.get(iso)?.spotsLeft === 0 ? 'danger' : 'ocean'}
            selected={date === iso}
            onPress={() => onDate(iso)}
          />
        ))}
      </View>
      <View style={styles.inline}>
        <TextInput
          value={date}
          onChangeText={onDate}
          placeholder="YYYY-MM-DD"
          placeholderTextColor={colors.inkSoft}
          autoCapitalize="none"
          autoCorrect={false}
          style={[styles.input, styles.flex]}
        />
        <TextInput
          value={time}
          onChangeText={onTime}
          placeholder="HH:MM (24h) or blank"
          placeholderTextColor={colors.inkSoft}
          autoCapitalize="none"
          autoCorrect={false}
          style={[styles.input, styles.flex]}
        />
      </View>
      {chosen ? (
        <Text style={[styles.meta, chosen.spotsLeft <= 0 ? styles.full : styles.open]}>
          {chosen.spotsLeft <= 0 ? 'Full that day — pick another day' : spotsLabel(chosen)}
          {chosen.unstaffedJobs > 0 ? ' · ⚠ a job that day is not staffed yet' : ''}
        </Text>
      ) : null}
    </>
  );
}

/**
 * Bronze / Silver / Gold with their prices, or Custom with the rep's own
 * yearly price (no floor for now; admins just see it tagged Custom).
 */
function PlanPicker({
  plans,
  plan,
  custom,
  onPlan,
  onCustom,
}: {
  plans: ServicePlan[];
  plan: PlanChoice | null;
  custom: string;
  onPlan: (p: PlanChoice) => void;
  onCustom: (v: string) => void;
}) {
  return (
    <>
      <View style={styles.chips}>
        {plans.map((p) => (
          <Chip
            key={p.tier}
            label={`${p.label} ${formatCents(p.amountCents)}`}
            tone="olive"
            selected={plan === p.tier}
            onPress={() => onPlan(p.tier)}
          />
        ))}
        <Chip label="Custom" tone="olive" selected={plan === 'custom'} onPress={() => onPlan('custom')} />
      </View>
      {plan === 'custom' ? (
        <TextInput
          value={custom}
          onChangeText={onCustom}
          placeholder="Yearly price, e.g. 650"
          placeholderTextColor={colors.inkSoft}
          keyboardType="decimal-pad"
          style={styles.input}
        />
      ) : null}
      <Text style={styles.meta}>Per year · 2-year agreement · first year charged after the first visit.</Text>
    </>
  );
}

/** The plan choice as the database wants it, or the reason it is not ready. */
function planInput(plan: PlanChoice | null, custom: string): { plan: PlanChoice; priceCents: number | null } | string {
  if (!plan) return 'Pick a plan.';
  if (plan !== 'custom') return { plan, priceCents: null };
  const cents = parseDollars(custom);
  return cents ? { plan, priceCents: cents } : 'Enter the custom yearly price, e.g. 650.';
}

export function BookVisitForm({
  leadId,
  onBooked,
  onCancel,
}: {
  leadId: string;
  onBooked: (message: string) => void;
  onCancel: () => void;
}) {
  const [kind, setKind] = useState<ServiceKind>('Cleaning');
  const [date, setDate] = useState(isoPlusDays(1));
  const [time, setTime] = useState('');
  const [note, setNote] = useState('');
  const [plans, setPlans] = useState<ServicePlan[]>([]);
  const [plan, setPlan] = useState<PlanChoice | null>(null);
  const [custom, setCustom] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void fetchServicePlans().then((p) => {
      if (!cancelled) setPlans(p);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const submit = async () => {
    const chosen = planInput(plan, custom);
    if (typeof chosen === 'string') {
      setError(chosen);
      return;
    }
    setSaving(true);
    setError(null);
    const result = await bookServiceVisit({
      leadId,
      kind,
      date: date.trim(),
      startTime: time.trim() || null,
      note,
      plan: chosen.plan,
      priceCents: chosen.priceCents,
    });
    setSaving(false);
    if (result.ok) {
      onBooked(
        `Booked ${result.jobNumber}` +
          (result.possibleDuplicate ? ' — this person may already be a customer; an admin will check.' : '.'),
      );
    } else {
      setError(result.message);
    }
  };

  return (
    <View style={styles.box}>
      <Text style={styles.label}>Visit</Text>
      <View style={styles.chips}>
        {SERVICE_KINDS.map((k) => (
          <Chip key={k} label={k} tone="olive" selected={kind === k} onPress={() => setKind(k)} />
        ))}
      </View>
      <Text style={styles.label}>Plan</Text>
      <PlanPicker plans={plans} plan={plan} custom={custom} onPlan={setPlan} onCustom={setCustom} />
      <Text style={styles.label}>When</Text>
      <DateFields date={date} time={time} onDate={setDate} onTime={setTime} />
      <TextInput
        value={note}
        onChangeText={setNote}
        placeholder="Note for the crew — gate code, roof access…"
        placeholderTextColor={colors.inkSoft}
        style={styles.input}
      />
      {error ? <Text style={styles.error}>{error}</Text> : null}
      <View style={styles.buttons}>
        <Pressable onPress={onCancel} style={({ pressed }) => [styles.cancel, pressed && styles.pressed]}>
          <Text style={styles.cancelText}>Cancel</Text>
        </Pressable>
        <Pressable onPress={() => void submit()} disabled={saving} style={({ pressed }) => [styles.save, (pressed || saving) && styles.pressed]}>
          {saving ? <ActivityIndicator color={colors.textOnAction} size="small" /> : <Text style={styles.saveText}>Book visit</Text>}
        </Pressable>
      </View>
    </View>
  );
}

type Mode = 'view' | 'reschedule' | 'cancel' | 'plan';

export function VisitCard({
  jobId,
  onChanged,
  person,
}: {
  jobId: string;
  onChanged: () => void;
  /** Who the card link is for — prefills the text / email. */
  person?: { name: string; phone: string | null; email: string | null };
}) {
  const [visit, setVisit] = useState<ServiceVisit | null | 'loading'>('loading');
  const [mode, setMode] = useState<Mode>('view');
  const [date, setDate] = useState('');
  const [time, setTime] = useState('');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [link, setLink] = useState<string | null>(null);
  const [linkBusy, setLinkBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [texting, setTexting] = useState(false);
  const [texted, setTexted] = useState(false);
  const [plans, setPlans] = useState<ServicePlan[]>([]);
  const [plan, setPlan] = useState<PlanChoice | null>(null);
  const [custom, setCustom] = useState('');

  const load = useCallback(async () => {
    setVisit(await fetchServiceVisit(jobId));
  }, [jobId]);

  useEffect(() => {
    setVisit('loading');
    setMode('view');
    setError(null);
    setLink(null);
    setCopied(false);
    setTexted(false);
    void load();
  }, [load]);

  if (visit === 'loading') {
    return <ActivityIndicator color={colors.ocean} />;
  }
  if (!visit) {
    return <Text style={styles.meta}>The booked visit could not be loaded.</Text>;
  }

  const open = visit.stage === 'Service Call';
  const when = [visit.date ? formatShortDate(visit.date) : 'No date', formatVisitTime(visit.startTime)].filter(Boolean).join(' · ');

  const firstName = (person?.name ?? '').split(' ')[0] || 'there';
  const sold = planSummary(visit.planTier, visit.planPriceCents);
  const planWords =
    visit.planTier && visit.planPriceCents
      ? `${planSummary(visit.planTier, null)} solar service plan (${formatCents(visit.planPriceCents)} a year, 2-year agreement)`
      : 'annual solar service plan';
  const linkMessage = (url: string) =>
    `Hi ${firstName}, this is DC Solar. Here is a secure Stripe link to save the card for your ${planWords}. Nothing is charged until after your first visit: ${url}`;

  const makeLink = async () => {
    setLinkBusy(true);
    setError(null);
    setCopied(false);
    const result = await requestCardLink(jobId);
    setLinkBusy(false);
    if (result.ok) setLink(result.url);
    else setError(result.message);
  };

  const run = async (fn: () => Promise<{ ok: true } | { ok: false; message: string }>) => {
    setBusy(true);
    setError(null);
    const result = await fn();
    setBusy(false);
    if (result.ok) {
      setMode('view');
      await load();
      onChanged();
    } else {
      setError(result.message);
    }
  };

  return (
    <View style={styles.box}>
      <View style={styles.headRow}>
        <Ionicons name={open ? 'calendar-outline' : 'checkmark-circle'} size={16} color={open ? colors.ocean : colors.olive} />
        <Text style={styles.title}>
          {visit.kind ?? 'Visit'} · {visit.jobNumber ?? ''}
        </Text>
        <View style={[styles.tag, visit.paidAt ? styles.tagPaid : styles.tagUnpaid]}>
          <Text style={[styles.tagText, visit.paidAt ? styles.tagTextPaid : styles.tagTextUnpaid]}>{visit.paidAt ? 'Paid' : 'Not paid'}</Text>
        </View>
      </View>
      <Text style={styles.meta}>{open ? when : `Done ${visit.completedOn ? formatShortDate(visit.completedOn) : ''}`}</Text>
      <Text style={[styles.meta, styles.plan]}>{sold ? `${sold} · 2-year agreement` : 'No plan picked'}</Text>
      {!visit.paidAt ? (
        <View style={styles.cardRow}>
          <Ionicons
            name={visit.cardOnFileAt ? 'card' : 'card-outline'}
            size={14}
            color={visit.cardOnFileAt ? colors.olive : colors.inkSoft}
          />
          <Text style={[styles.meta, visit.cardOnFileAt ? styles.cardOk : null]}>
            {visit.cardOnFileAt ? `Card on file ✓ ${visit.cardLabel ?? ''}` : 'No card on file yet'}
          </Text>
        </View>
      ) : null}
      {visit.paymentIssue && !visit.paidAt ? <Text style={styles.error}>{visit.paymentIssue}</Text> : null}
      {!visit.paidAt && (open || !visit.cardOnFileAt) ? (
        link ? (
          <View style={styles.linkBox}>
            <Text style={styles.linkText} numberOfLines={2} selectable>
              {link}
            </Text>
            <View style={styles.chips}>
              <Chip
                label={copied ? 'Copied' : 'Copy'}
                tone="ocean"
                icon="copy-outline"
                onPress={() => {
                  void Clipboard.setStringAsync(link).then(() => setCopied(true));
                }}
              />
              {visit.customerId ? (
                // Texted by DC Solar (Twilio) from the rep's own DC Solar
                // number — never the rep's personal phone (2026-10-05).
                <Chip
                  label={texting ? 'Texting…' : texted ? 'Texted ✓' : 'Text it'}
                  tone="ocean"
                  icon="chatbubble-outline"
                  onPress={
                    texting || texted
                      ? undefined
                      : () => {
                          setTexting(true);
                          setError(null);
                          void sendSms({ customerId: visit.customerId!, body: linkMessage(link) }).then((result) => {
                            setTexting(false);
                            if (result.ok) setTexted(true);
                            else setError(result.message);
                          });
                        }
                  }
                />
              ) : null}
              {person?.email ? (
                <Chip
                  label="Email"
                  tone="ocean"
                  icon="mail-outline"
                  onPress={() => {
                    const subject = encodeURIComponent('Your DC Solar service plan — save your card');
                    Linking.openURL(`mailto:${person.email}?subject=${subject}&body=${encodeURIComponent(linkMessage(link))}`).catch(() => {});
                  }}
                />
              ) : null}
            </View>
            <Text style={styles.meta}>Good for 24 hours. The card shows here once they save it.</Text>
          </View>
        ) : (
          <View style={styles.chips}>
            <Chip
              label={linkBusy ? 'Making link…' : visit.cardOnFileAt ? 'New card link' : 'Card link'}
              tone="olive"
              icon="card-outline"
              onPress={linkBusy ? undefined : () => void makeLink()}
            />
          </View>
        )
      ) : null}

      {open && mode === 'view' ? (
        <View style={styles.chips}>
          <Chip
            label="Reschedule"
            tone="ocean"
            icon="calendar-outline"
            onPress={() => {
              setDate(visit.date ?? isoPlusDays(1));
              setTime(visit.startTime ? visit.startTime.slice(0, 5) : '');
              setMode('reschedule');
            }}
          />
          {!visit.paidAt ? (
            <Chip
              label="Change plan"
              tone="olive"
              icon="pricetag-outline"
              onPress={() => {
                setPlan(visit.planTier);
                setCustom(visit.planTier === 'custom' && visit.planPriceCents ? String(visit.planPriceCents / 100) : '');
                setMode('plan');
                if (plans.length === 0) void fetchServicePlans().then(setPlans);
              }}
            />
          ) : null}
          <Chip label="Cancel visit" tone="danger" icon="close-circle-outline" onPress={() => setMode('cancel')} />
        </View>
      ) : null}

      {mode === 'plan' ? (
        <>
          <PlanPicker plans={plans} plan={plan} custom={custom} onPlan={setPlan} onCustom={setCustom} />
          <View style={styles.buttons}>
            <Pressable onPress={() => setMode('view')} style={({ pressed }) => [styles.cancel, pressed && styles.pressed]}>
              <Text style={styles.cancelText}>Back</Text>
            </Pressable>
            <Pressable
              onPress={() => {
                const chosen = planInput(plan, custom);
                if (typeof chosen === 'string') {
                  setError(chosen);
                  return;
                }
                void run(() => setServicePlan(jobId, chosen.plan, chosen.priceCents));
              }}
              disabled={busy}
              style={({ pressed }) => [styles.save, (pressed || busy) && styles.pressed]}>
              {busy ? <ActivityIndicator color={colors.textOnAction} size="small" /> : <Text style={styles.saveText}>Save plan</Text>}
            </Pressable>
          </View>
        </>
      ) : null}

      {mode === 'reschedule' ? (
        <>
          <DateFields date={date} time={time} onDate={setDate} onTime={setTime} excludeJobId={jobId} />
          <View style={styles.buttons}>
            <Pressable onPress={() => setMode('view')} style={({ pressed }) => [styles.cancel, pressed && styles.pressed]}>
              <Text style={styles.cancelText}>Back</Text>
            </Pressable>
            <Pressable
              onPress={() => void run(() => rescheduleServiceVisit(jobId, date.trim(), time.trim() || null))}
              disabled={busy}
              style={({ pressed }) => [styles.save, (pressed || busy) && styles.pressed]}>
              {busy ? <ActivityIndicator color={colors.textOnAction} size="small" /> : <Text style={styles.saveText}>Save new time</Text>}
            </Pressable>
          </View>
        </>
      ) : null}

      {mode === 'cancel' ? (
        <>
          <TextInput
            value={reason}
            onChangeText={setReason}
            placeholder="Why? (customer travelling, changed their mind…)"
            placeholderTextColor={colors.inkSoft}
            style={styles.input}
          />
          <Text style={styles.meta}>The visit comes off the calendar and the lead goes back to Interested.</Text>
          <View style={styles.buttons}>
            <Pressable onPress={() => setMode('view')} style={({ pressed }) => [styles.cancel, pressed && styles.pressed]}>
              <Text style={styles.cancelText}>Back</Text>
            </Pressable>
            <Pressable
              onPress={() => void run(() => cancelServiceVisit(jobId, reason))}
              disabled={busy}
              style={({ pressed }) => [styles.save, styles.danger, (pressed || busy) && styles.pressed]}>
              {busy ? <ActivityIndicator color={colors.textInverse} size="small" /> : <Text style={[styles.saveText, styles.dangerText]}>Cancel visit</Text>}
            </Pressable>
          </View>
        </>
      ) : null}

      {error ? <Text style={styles.error}>{error}</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  box: { gap: spacing.xs, backgroundColor: colors.canvas, borderRadius: radii.sm, padding: spacing.sm, borderWidth: 1, borderColor: colors.line },
  headRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs },
  title: { flex: 1, color: colors.ink, fontSize: 13, fontWeight: '800' },
  meta: { color: colors.inkSoft, fontSize: 12, fontWeight: '600' },
  label: { color: colors.inkSoft, fontSize: 10, fontWeight: '800', letterSpacing: 0.5, textTransform: 'uppercase', marginTop: spacing.xs },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.xs },
  inline: { flexDirection: 'row', gap: spacing.xs },
  flex: { flex: 1 },
  input: {
    backgroundColor: colors.surface,
    borderRadius: radii.sm,
    borderWidth: 1,
    borderColor: colors.line,
    paddingHorizontal: spacing.sm + 2,
    paddingVertical: spacing.sm,
    color: colors.ink,
    fontSize: 14,
    fontWeight: '500',
  },
  tag: { paddingHorizontal: spacing.sm, paddingVertical: 2, borderRadius: radii.pill },
  cardRow: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  cardOk: { color: colors.olive },
  plan: { color: colors.ink },
  full: { color: colors.danger },
  open: { color: colors.olive },
  linkBox: { gap: spacing.xs, padding: spacing.sm, borderRadius: radii.sm, backgroundColor: colors.surface },
  linkText: { color: colors.ocean, fontSize: 12, fontWeight: '600' },
  tagPaid: { backgroundColor: colors.mintSoft },
  tagUnpaid: { backgroundColor: colors.coralSoft },
  tagText: { fontSize: 11, fontWeight: '800' },
  tagTextPaid: { color: colors.mintDeep },
  tagTextUnpaid: { color: colors.coralDeep },
  error: { color: colors.danger, fontSize: 12, fontWeight: '700' },
  buttons: { flexDirection: 'row', justifyContent: 'flex-end', alignItems: 'center', gap: spacing.sm, marginTop: spacing.xs },
  cancel: { paddingHorizontal: spacing.md, paddingVertical: 6, borderRadius: radii.pill },
  cancelText: { color: colors.inkSoft, fontSize: 13, fontWeight: '700' },
  save: { backgroundColor: colors.sun, paddingHorizontal: spacing.lg, paddingVertical: 6, borderRadius: radii.pill, minWidth: 110, alignItems: 'center' },
  saveText: { color: colors.textOnAction, fontSize: 13, fontWeight: '800' },
  danger: { backgroundColor: colors.danger },
  dangerText: { color: colors.textInverse },
  pressed: { opacity: 0.6 },
});
