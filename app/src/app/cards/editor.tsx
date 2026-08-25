import Ionicons from '@expo/vector-icons/Ionicons';
import * as ImagePicker from 'expo-image-picker';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  ScrollView,
  StyleSheet,
  Switch,
  TextInput,
  useWindowDimensions,
  View,
} from 'react-native';

import { TradingCard } from '@/components/cards/TradingCard';
import {
  AnimatedPressable,
  AppText,
  Button,
  Card,
  Chip,
  Screen,
  SectionHeader,
} from '@/components/ui';
import { colors, radii, spacing } from '@/constants/theme';
import {
  CARD_DRAFT_PARAM,
  CARD_RARITIES,
  CARD_TYPES,
  archiveCard,
  cardTypeLabel,
  fetchCard,
  fetchCardArtUrls,
  fetchCardJobOptions,
  rarityLabel,
  regenerateCardArt,
  saveCard,
  slugifyCardId,
  takeCardDraft,
  unarchiveCard,
  uploadCardArt,
  type CardDraft,
  type CardJobOption,
  type CardRarity,
  type CardRecord,
  type CardType,
} from '@/lib/cards';
import { useRole } from '@/lib/role';

/** Everything the form holds. Numbers live as text until they are saved. */
interface FormState {
  card_type: CardType;
  title: string;
  rarity: CardRarity;
  ability: string;
  flavor: string;
  art_prompt: string;
  job_number: string;
  job_id: string | null;
  location: string;
  service_type: string;
  panels: string;
  kw_dc: string;
  annual_kwh: string;
  difficulty: string;
  reward_kw: string;
  employee_id: string | null;
  role: string;
  power: string;
  bonus: string;
  full_art: boolean;
  holo_only: boolean;
}

const BLANK: FormState = {
  card_type: 'job',
  title: '',
  rarity: 'common',
  ability: '',
  flavor: '',
  art_prompt: '',
  job_number: '',
  job_id: null,
  location: '',
  service_type: '',
  panels: '',
  kw_dc: '',
  annual_kwh: '',
  difficulty: '',
  reward_kw: '',
  employee_id: null,
  role: '',
  power: '',
  bonus: '',
  full_art: false,
  holo_only: false,
};

/** '' → null, so a cleared field genuinely clears the column. */
function toNumber(text: string): number | null {
  const trimmed = text.trim();
  if (trimmed.length === 0) return null;
  const value = Number(trimmed);
  return Number.isFinite(value) ? value : null;
}

/** null → '', because every number in this form lives as text until save. */
function toText(value: number | null): string {
  return value != null ? String(value) : '';
}

/**
 * A forged draft as form state.
 *
 * The draft's `id` is thrown away deliberately: it is the model's suggestion,
 * and leaving it off means the save takes the ordinary insert path, where
 * `saveCard` mints the slug from the title the admin actually settled on.
 */
function formFromDraft(draft: CardDraft): FormState {
  return {
    card_type: draft.card_type,
    title: draft.title,
    rarity: draft.rarity,
    ability: draft.ability ?? '',
    flavor: draft.flavor ?? '',
    art_prompt: draft.art_prompt ?? '',
    job_number: draft.job_number ?? '',
    job_id: null,
    location: draft.location ?? '',
    service_type: draft.service_type ?? '',
    panels: toText(draft.panels),
    kw_dc: toText(draft.kw_dc),
    annual_kwh: toText(draft.annual_kwh),
    difficulty: toText(draft.difficulty),
    reward_kw: toText(draft.reward_kw),
    employee_id: null,
    role: draft.role ?? '',
    power: toText(draft.power),
    bonus: toText(draft.bonus),
    full_art: draft.full_art,
    holo_only: draft.holo_only,
  };
}

/**
 * Add or edit one card.
 *
 * THE PREVIEW IS THE POINT. Card design is a visual craft — an ability that
 * runs to four lines, a title that wraps, a rarity that fights the artwork —
 * and none of that is visible in a form. The real `TradingCard` renders from
 * the form state on every keystroke, so what an admin is about to save is
 * what they are already looking at.
 *
 * ART COSTS MONEY. "Regenerate with AI" bills Devon's Gemini key about four
 * cents per press and takes roughly twenty seconds, so it is behind an
 * explicit in-screen confirmation rather than a one-tap button — and the
 * cheap path (pick a photo, compressed on device) sits right next to it.
 */
export default function CardEditorScreen() {
  const params = useLocalSearchParams<{ id?: string; draft?: string }>();
  const id = params.id;
  /**
   * `?draft=1` — the flag the forge sets on its way here. The card itself is
   * NOT in the URL: it is waiting in `lib/cards`, because a dozen nullable
   * fields and two paragraphs of prose do not belong in a query string. See
   * `stashCardDraft`.
   */
  const wantsDraft = params[CARD_DRAFT_PARAM] === '1';
  const router = useRouter();
  const role = useRole();
  const isAdmin = role?.isAdmin ?? false;
  const { width } = useWindowDimensions();

  const editing = typeof id === 'string' && id.length > 0;

  const [form, setForm] = useState<FormState>(BLANK);
  const [existing, setExisting] = useState<CardRecord | null>(null);
  const [loading, setLoading] = useState(editing);
  const [saving, setSaving] = useState(false);
  const [artBusy, setArtBusy] = useState(false);
  const [confirmRegen, setConfirmRegen] = useState(false);
  const [status, setStatus] = useState<{ kind: 'success' | 'error'; message: string } | null>(null);

  const [artUrl, setArtUrl] = useState<string | null>(null);
  /** A just-picked local file, shown before the upload finishes. */
  const [localArt, setLocalArt] = useState<string | null>(null);

  const [jobs, setJobs] = useState<CardJobOption[]>([]);
  const [jobPickerOpen, setJobPickerOpen] = useState(false);
  const [jobSearch, setJobSearch] = useState('');

  const filteredJobs = useMemo(() => {
    const q = jobSearch.trim().toLowerCase();
    if (!q) return jobs;
    return jobs.filter((job) =>
      [job.jobNumber, job.name, job.customerName, job.address].some((field) =>
        field?.toLowerCase().includes(q),
      ),
    );
  }, [jobs, jobSearch]);

  const set = useCallback(<K extends keyof FormState>(key: K, value: FormState[K]) => {
    setForm((prev) => ({ ...prev, [key]: value }));
  }, []);

  const load = useCallback(async () => {
    if (!editing || typeof id !== 'string') return;
    const row = await fetchCard(id);
    if (!row) {
      setStatus({ kind: 'error', message: `There is no card called "${id}".` });
      setLoading(false);
      return;
    }
    setExisting(row);
    setForm({
      card_type: row.card_type,
      title: row.title,
      rarity: row.rarity,
      ability: row.ability ?? '',
      flavor: row.flavor ?? '',
      art_prompt: row.art_prompt ?? '',
      job_number: row.job_number ?? '',
      job_id: row.job_id,
      location: row.location ?? '',
      service_type: row.service_type ?? '',
      panels: row.panels != null ? String(row.panels) : '',
      kw_dc: row.kw_dc != null ? String(row.kw_dc) : '',
      annual_kwh: row.annual_kwh != null ? String(row.annual_kwh) : '',
      difficulty: row.difficulty != null ? String(row.difficulty) : '',
      reward_kw: row.reward_kw != null ? String(row.reward_kw) : '',
      employee_id: row.employee_id,
      role: row.role ?? '',
      power: row.power != null ? String(row.power) : '',
      bonus: row.bonus != null ? String(row.bonus) : '',
      full_art: row.full_art,
      holo_only: row.holo_only,
    });
    setLoading(false);
    const urls = await fetchCardArtUrls([row]);
    setArtUrl(urls.get(row.id) ?? null);
  }, [editing, id]);

  useEffect(() => {
    void load();
  }, [load]);

  /**
   * Seed the form from the forge, ONCE.
   *
   * The ref rather than state is the whole trick: React re-runs effects on a
   * StrictMode remount, and `takeCardDraft` empties the slot, so a second run
   * would find nothing and — with a state flag, which the remount would read
   * as still-false — could blank a form the admin has already started typing
   * in. A ref survives the remount and makes the second run a no-op.
   *
   * Nothing is saved here. This is a filled-in form, not a card; the admin
   * still presses Create.
   */
  const draftSeeded = useRef(false);
  useEffect(() => {
    if (editing || !wantsDraft || draftSeeded.current) return;
    draftSeeded.current = true;
    const draft = takeCardDraft();
    if (!draft) return;
    setForm(formFromDraft(draft));
    setStatus({
      kind: 'success',
      message: `Drafted "${draft.title}". Change anything you like, then create the card.`,
    });
  }, [editing, wantsDraft]);

  useEffect(() => {
    if (!isAdmin) return;
    void fetchCardJobOptions().then(setJobs);
  }, [isAdmin]);

  // --- the live preview -----------------------------------------------------
  const preview: CardRecord = useMemo(
    () => ({
      id: existing?.id ?? slugifyCardId(form.title || 'new card', form.card_type),
      company: existing?.company ?? 'dc-solar',
      set_code: existing?.set_code ?? 'DCS26',
      card_number: existing?.card_number ?? null,
      sort_order: existing?.sort_order ?? 0,
      card_type: form.card_type,
      title: form.title.trim() || 'Untitled card',
      rarity: form.rarity,
      ability: form.ability.trim() || null,
      flavor: form.flavor.trim() || null,
      art_prompt: form.art_prompt.trim() || null,
      job_number: form.job_number.trim() || null,
      job_id: form.job_id,
      location: form.location.trim() || null,
      service_type: form.service_type.trim() || null,
      panels: toNumber(form.panels),
      kw_dc: toNumber(form.kw_dc),
      annual_kwh: toNumber(form.annual_kwh),
      difficulty: toNumber(form.difficulty),
      reward_kw: toNumber(form.reward_kw),
      employee_id: form.employee_id,
      role: form.role.trim() || null,
      power: toNumber(form.power),
      bonus: toNumber(form.bonus),
      full_art: form.full_art,
      holo_only: form.holo_only,
      art_path: existing?.art_path ?? null,
      version: existing?.version ?? 1,
      archived_at: existing?.archived_at ?? null,
      created_by: existing?.created_by ?? null,
      created_at: existing?.created_at ?? null,
      updated_at: existing?.updated_at ?? null,
    }),
    [form, existing],
  );

  const previewWidth = Math.min(240, width - spacing.lg * 2);
  const isJobLike = form.card_type === 'job' || form.card_type === 'special';

  // --- actions --------------------------------------------------------------
  const onSave = async () => {
    setStatus(null);
    if (!form.title.trim()) {
      setStatus({ kind: 'error', message: 'The card needs a title.' });
      return;
    }
    setSaving(true);
    const result = await saveCard({
      id: existing?.id ?? null,
      card_type: form.card_type,
      title: form.title,
      rarity: form.rarity,
      ability: form.ability,
      flavor: form.flavor,
      art_prompt: form.art_prompt,
      job_number: form.job_number,
      job_id: form.job_id,
      location: form.location,
      service_type: form.service_type,
      panels: toNumber(form.panels),
      kw_dc: toNumber(form.kw_dc),
      annual_kwh: toNumber(form.annual_kwh),
      difficulty: toNumber(form.difficulty),
      reward_kw: toNumber(form.reward_kw),
      employee_id: form.employee_id,
      role: form.role,
      power: toNumber(form.power),
      bonus: toNumber(form.bonus),
      full_art: form.full_art,
      holo_only: form.holo_only,
    });
    setSaving(false);

    if (!result.ok) {
      setStatus({ kind: 'error', message: result.message });
      return;
    }
    if (result.created) {
      // Land on the card that was just made, so the next thing an admin does
      // (add art) happens against a real row.
      router.replace({ pathname: '/cards/editor', params: { id: result.id } });
      setStatus({ kind: 'success', message: `Created ${form.title.trim()}.` });
      return;
    }
    setStatus({ kind: 'success', message: 'Saved.' });
    void load();
  };

  const onPickArt = async () => {
    if (!existing) {
      setStatus({ kind: 'error', message: 'Save the card first, then give it artwork.' });
      return;
    }
    setStatus(null);
    try {
      const result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ['images'],
        allowsEditing: true,
        // Card art is a 3:4 portrait; the print template crops a 1.63:1
        // window out of the middle of it.
        aspect: [3, 4],
        quality: 1,
      });
      if (result.canceled || !result.assets?.length) return;
      const asset = result.assets[0];
      setLocalArt(asset.uri);
      setArtBusy(true);
      const upload = await uploadCardArt({
        cardId: existing.id,
        uri: asset.uri,
        version: existing.version,
      });
      setArtBusy(false);
      if (!upload.ok) {
        setStatus({ kind: 'error', message: upload.message });
        return;
      }
      setStatus({ kind: 'success', message: 'Artwork saved.' });
      setLocalArt(null);
      void load();
    } catch {
      setArtBusy(false);
      setStatus({ kind: 'error', message: 'That image could not be used. Try another one.' });
    }
  };

  const onRegenerate = async () => {
    if (!existing) return;
    setConfirmRegen(false);
    setStatus(null);
    setArtBusy(true);
    const result = await regenerateCardArt(existing.id, true);
    setArtBusy(false);
    if (!result.ok) {
      setStatus({ kind: 'error', message: result.message });
      return;
    }
    setStatus({ kind: 'success', message: 'New artwork drawn.' });
    void load();
  };

  const onToggleArchive = async () => {
    if (!existing) return;
    setStatus(null);
    setSaving(true);
    const result = existing.archived_at
      ? await unarchiveCard(existing.id)
      : await archiveCard(existing.id);
    setSaving(false);
    if (!result.ok) {
      setStatus({ kind: 'error', message: result.message });
      return;
    }
    setStatus({
      kind: 'success',
      message: existing.archived_at ? 'Back in the binder.' : 'Pulled from the set.',
    });
    void load();
  };

  // --- gates ----------------------------------------------------------------
  if (role === null) {
    return (
      <>
        <Stack.Screen options={{ title: editing ? 'Edit card' : 'New card' }} />
        <Screen edges={[]}>
          <View style={styles.center}>
            <ActivityIndicator color={colors.accentPrimary} />
          </View>
        </Screen>
      </>
    );
  }

  if (!isAdmin) {
    return (
      <>
        <Stack.Screen options={{ title: 'Card editor' }} />
        <Screen edges={[]}>
          <Card style={styles.center}>
            <View style={styles.badge}>
              <Ionicons name="lock-closed" size={26} color={colors.accentPrimary} />
            </View>
            <AppText variant="heading" align="center">
              Admins only
            </AppText>
            <AppText variant="body" color={colors.textMuted} align="center">
              The card set is company-published artwork, so only an owner or operator can change it.
              You can still browse every card in the binder.
            </AppText>
            <Button
              label="Back to the binder"
              variant="secondary"
              size="sm"
              onPress={() => router.replace('/cards')}
            />
          </Card>
        </Screen>
      </>
    );
  }

  if (loading) {
    return (
      <>
        <Stack.Screen options={{ title: 'Edit card' }} />
        <Screen edges={[]}>
          <View style={styles.center}>
            <ActivityIndicator color={colors.accentPrimary} />
          </View>
        </Screen>
      </>
    );
  }

  return (
    <>
      <Stack.Screen options={{ title: editing ? 'Edit card' : 'New card' }} />
      <Screen edges={[]}>
        {/* preview */}
        <View style={styles.previewStage}>
          <TradingCard
            card={preview}
            artUrl={localArt ?? artUrl}
            variant={form.holo_only ? 'holo' : 'base'}
            width={previewWidth}
          />
          {artBusy ? (
            <View style={styles.artBusy}>
              <ActivityIndicator color={colors.accentPrimary} />
              <AppText variant="caption" color={colors.textMuted}>
                Working on the artwork…
              </AppText>
            </View>
          ) : null}
        </View>

        {status ? (
          <Card tone={status.kind === 'error' ? 'danger' : 'sunk'}>
            <AppText
              variant="bodyStrong"
              color={status.kind === 'error' ? colors.danger : colors.oliveDeep}>
              {status.message}
            </AppText>
          </Card>
        ) : null}

        {/* the card */}
        <Card>
          <SectionHeader title="The card" />

          <AppText variant="caption" color={colors.textMuted}>
            Type
          </AppText>
          <View style={styles.chipRow}>
            {CARD_TYPES.map((type) => (
              <Chip
                key={type}
                label={cardTypeLabel(type)}
                tone="olive"
                selected={form.card_type === type}
                onPress={() => set('card_type', type)}
              />
            ))}
          </View>

          <Field
            label="Title"
            value={form.title}
            onChangeText={(text) => set('title', text)}
            placeholder="The Oberlin Beast"
          />

          <AppText variant="caption" color={colors.textMuted} style={styles.fieldLabel}>
            Rarity
          </AppText>
          <View style={styles.chipRow}>
            {CARD_RARITIES.map((rarity) => (
              <Chip
                key={rarity}
                label={rarityLabel(rarity)}
                tone="ocean"
                selected={form.rarity === rarity}
                onPress={() => set('rarity', rarity)}
              />
            ))}
          </View>

          <Field
            label="Ability"
            value={form.ability}
            onChangeText={(text) => set('ability', text)}
            placeholder="What the card does in the game. Leave blank for a plain job."
            multiline
          />
          <Field
            label="Flavor"
            value={form.flavor}
            onChangeText={(text) => set('flavor', text)}
            placeholder="The joke. Quotes are added automatically."
            multiline
          />
        </Card>

        {/* type-specific */}
        {isJobLike ? (
          <Card>
            <SectionHeader
              title="The work"
              subtitle="Leave a stat blank and it is left off the card entirely."
            />
            <Field
              label="Job number"
              value={form.job_number}
              onChangeText={(text) => set('job_number', text)}
              placeholder="DC-26019"
              autoCapitalize="characters"
            />

            <AppText variant="caption" color={colors.textMuted} style={styles.fieldLabel}>
              Linked job
            </AppText>
            <AnimatedPressable
              onPress={() => setJobPickerOpen((open) => !open)}
              haptic="tapLight"
              accessibilityRole="button"
              accessibilityLabel="Choose the linked job"
              style={styles.picker}>
              <AppText variant="bodyStrong" numberOfLines={1} style={styles.pickerLabel}>
                {form.job_id
                  ? (jobs.find((job) => job.id === form.job_id)?.jobNumber ??
                    'Linked to a job record')
                  : 'Not linked'}
              </AppText>
              <Ionicons
                name={jobPickerOpen ? 'chevron-up' : 'chevron-down'}
                size={16}
                color={colors.textMuted}
              />
            </AnimatedPressable>
            {jobPickerOpen ? (
              <View style={styles.pickerList}>
                {jobs.length > 6 ? (
                  <Field
                    label="Search"
                    value={jobSearch}
                    onChangeText={setJobSearch}
                    placeholder="Search job, customer or address"
                  />
                ) : null}
                <Chip
                  label="Not linked"
                  tone="neutral"
                  selected={form.job_id === null}
                  onPress={() => {
                    set('job_id', null);
                    setJobPickerOpen(false);
                  }}
                />
                <ScrollView style={styles.pickerScroll} nestedScrollEnabled>
                  {filteredJobs.map((job) => (
                    <AnimatedPressable
                      key={job.id}
                      onPress={() => {
                        set('job_id', job.id);
                        if (!form.job_number.trim() && job.jobNumber) {
                          set('job_number', job.jobNumber);
                        }
                        setJobPickerOpen(false);
                      }}
                      haptic="tapLight"
                      accessibilityRole="button"
                      accessibilityLabel={job.jobNumber ?? job.name ?? 'Job'}
                      style={styles.pickerRow}>
                      <AppText variant="bodyStrong">{job.jobNumber ?? 'No number'}</AppText>
                      {job.name ? (
                        <AppText variant="caption" color={colors.textMuted} numberOfLines={1}>
                          {job.name}
                        </AppText>
                      ) : null}
                      {job.customerName || job.address ? (
                        <AppText variant="caption" color={colors.textMuted} numberOfLines={1}>
                          {[job.customerName, job.address].filter(Boolean).join(' · ')}
                        </AppText>
                      ) : null}
                    </AnimatedPressable>
                  ))}
                  {jobs.length === 0 ? (
                    <AppText variant="caption" color={colors.textMuted}>
                      No jobs to link to.
                    </AppText>
                  ) : filteredJobs.length === 0 ? (
                    <AppText variant="caption" color={colors.textMuted}>
                      No jobs match &quot;{jobSearch.trim()}&quot;.
                    </AppText>
                  ) : null}
                </ScrollView>
              </View>
            ) : null}

            <Field
              label="Location"
              value={form.location}
              onChangeText={(text) => set('location', text)}
              placeholder="Overland Park, KS — city only, never a street address"
            />
            <Field
              label="Service type"
              value={form.service_type}
              onChangeText={(text) => set('service_type', text)}
              placeholder="Install · Removal & Reinstall · Critter Guard"
            />
            <View style={styles.numberRow}>
              <Field
                label="Panels"
                value={form.panels}
                onChangeText={(text) => set('panels', text)}
                keyboardType="number-pad"
                style={styles.half}
              />
              <Field
                label="kWdc"
                value={form.kw_dc}
                onChangeText={(text) => set('kw_dc', text)}
                keyboardType="decimal-pad"
                style={styles.half}
              />
            </View>
            <View style={styles.numberRow}>
              <Field
                label="Annual kWh"
                value={form.annual_kwh}
                onChangeText={(text) => set('annual_kwh', text)}
                keyboardType="number-pad"
                style={styles.half}
              />
              <Field
                label="Difficulty"
                value={form.difficulty}
                onChangeText={(text) => set('difficulty', text)}
                keyboardType="number-pad"
                style={styles.half}
              />
            </View>
            <Field
              label="Reward kW"
              value={form.reward_kw}
              onChangeText={(text) => set('reward_kw', text)}
              keyboardType="number-pad"
            />
          </Card>
        ) : null}

        {form.card_type === 'crew' ? (
          <Card>
            <SectionHeader
              title="The person"
              subtitle="Power 0 is a real rating — The Inspector genuinely contributes nothing."
            />
            <Field
              label="Role"
              value={form.role}
              onChangeText={(text) => set('role', text)}
              placeholder="Owner / Deal Maker"
            />
            <Field
              label="Power"
              value={form.power}
              onChangeText={(text) => set('power', text)}
              keyboardType="number-pad"
              placeholder="0–4"
            />
            {form.employee_id ? (
              <AppText variant="caption" color={colors.textMuted} style={styles.fieldLabel}>
                This card is linked to an employee record. The link was set when the deck was
                imported and is kept as-is when you save.
              </AppText>
            ) : null}
          </Card>
        ) : null}

        {form.card_type === 'tool' ? (
          <Card>
            <SectionHeader
              title="The tool"
              subtitle="A bonus of 0 prints no stat at all — that is The Sharpie, and it is deliberate."
            />
            <Field
              label="Bonus power"
              value={form.bonus}
              onChangeText={(text) => set('bonus', text)}
              keyboardType="number-pad"
              placeholder="0–3"
            />
          </Card>
        ) : null}

        {/* presentation */}
        <Card padded={false}>
          <View style={styles.cardPad}>
            <SectionHeader title="Presentation" style={styles.noMargin} />
          </View>
          <ToggleRow
            title="Full art"
            subtitle="The picture fills the card and the text sits on a scrim."
            value={form.full_art}
            onValueChange={(value) => set('full_art', value)}
          />
          <ToggleRow
            title="Holographic only"
            subtitle="No base or foil printing exists. Sold a Damn Cow is the only one."
            value={form.holo_only}
            onValueChange={(value) => set('holo_only', value)}
          />
        </Card>

        {/* artwork */}
        <Card>
          <SectionHeader
            title="Artwork"
            subtitle={
              existing ? undefined : 'Save the card first — artwork is stored against its name.'
            }
          />
          <Field
            label="Art prompt"
            value={form.art_prompt}
            onChangeText={(text) => set('art_prompt', text)}
            placeholder="What the picture shows. This is what the AI draws from."
            multiline
          />
          <View style={styles.buttonRow}>
            <Button
              label="Pick from photos"
              icon="image-outline"
              variant="secondary"
              size="sm"
              disabled={!existing || artBusy}
              onPress={onPickArt}
            />
            <Button
              label="Regenerate with AI"
              icon="sparkles-outline"
              variant="secondary"
              size="sm"
              disabled={!existing || artBusy || !form.art_prompt.trim()}
              onPress={() => setConfirmRegen(true)}
            />
          </View>

          {confirmRegen ? (
            <Card tone="sunk" style={styles.confirm}>
              <AppText variant="bodyStrong">Draw new artwork for this card?</AppText>
              <AppText variant="caption" color={colors.textSecondary}>
                This asks Gemini to paint the card from its art prompt. It costs a few cents each
                time and usually takes about twenty seconds. The current artwork is replaced.
              </AppText>
              <View style={styles.buttonRow}>
                <Button
                  label="Cancel"
                  variant="ghost"
                  size="sm"
                  onPress={() => setConfirmRegen(false)}
                />
                <Button
                  label="Generate"
                  variant="primary"
                  size="sm"
                  onPress={onRegenerate}
                />
              </View>
            </Card>
          ) : null}
        </Card>

        {/* save / archive */}
        <Button
          label={editing ? 'Save changes' : 'Create card'}
          icon="checkmark"
          fullWidth
          loading={saving}
          onPress={onSave}
        />

        {existing ? (
          <Button
            label={existing.archived_at ? 'Put back in the set' : 'Pull from the set'}
            icon={existing.archived_at ? 'refresh' : 'archive-outline'}
            variant={existing.archived_at ? 'secondary' : 'danger'}
            fullWidth
            disabled={saving}
            onPress={onToggleArchive}
          />
        ) : null}

        {existing ? (
          <AppText variant="caption" color={colors.textMuted} align="center">
            {existing.id} · version {existing.version}
          </AppText>
        ) : null}
      </Screen>
    </>
  );
}

// ---------------------------------------------------------------------------
// Form parts
// ---------------------------------------------------------------------------

function Field({
  label,
  value,
  onChangeText,
  placeholder,
  multiline = false,
  keyboardType,
  autoCapitalize,
  style,
}: {
  label: string;
  value: string;
  onChangeText: (text: string) => void;
  placeholder?: string;
  multiline?: boolean;
  keyboardType?: 'number-pad' | 'decimal-pad';
  autoCapitalize?: 'none' | 'characters' | 'sentences';
  style?: object;
}) {
  return (
    <View style={[styles.field, style]}>
      <AppText variant="caption" color={colors.textMuted}>
        {label}
      </AppText>
      <TextInput
        value={value}
        onChangeText={onChangeText}
        placeholder={placeholder}
        placeholderTextColor={colors.textMuted}
        multiline={multiline}
        keyboardType={keyboardType}
        autoCapitalize={autoCapitalize}
        style={[styles.input, multiline && styles.inputMultiline]}
      />
    </View>
  );
}

function ToggleRow({
  title,
  subtitle,
  value,
  onValueChange,
}: {
  title: string;
  subtitle: string;
  value: boolean;
  onValueChange: (value: boolean) => void;
}) {
  return (
    <View style={styles.toggleRow}>
      <View style={styles.toggleText}>
        <AppText variant="bodyStrong">{title}</AppText>
        <AppText variant="caption" color={colors.textMuted}>
          {subtitle}
        </AppText>
      </View>
      <Switch
        value={value}
        onValueChange={onValueChange}
        trackColor={{ false: colors.border, true: colors.oliveMid }}
        thumbColor={colors.surface}
        accessibilityLabel={title}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  center: {
    alignItems: 'center',
    gap: spacing.sm,
    paddingVertical: spacing.xl,
  },
  badge: {
    width: 56,
    height: 56,
    borderRadius: radii.pill,
    backgroundColor: colors.oliveTint,
    alignItems: 'center',
    justifyContent: 'center',
  },
  previewStage: {
    alignItems: 'center',
    gap: spacing.sm,
    paddingTop: spacing.sm,
  },
  artBusy: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
  },
  chipRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.xs + 2,
    marginTop: spacing.xs,
    marginBottom: spacing.sm,
  },
  field: {
    gap: 4,
    marginBottom: spacing.sm,
  },
  fieldLabel: {
    marginTop: spacing.xs,
  },
  input: {
    backgroundColor: colors.surfaceSunk,
    borderRadius: radii.sm,
    borderWidth: 1,
    borderColor: colors.border,
    paddingHorizontal: spacing.sm + 4,
    paddingVertical: spacing.sm,
    color: colors.textPrimary,
    fontSize: 15,
  },
  inputMultiline: {
    minHeight: 84,
    textAlignVertical: 'top',
  },
  numberRow: {
    flexDirection: 'row',
    gap: spacing.sm,
  },
  half: {
    flex: 1,
  },
  picker: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.sm,
    backgroundColor: colors.surfaceSunk,
    borderRadius: radii.sm,
    borderWidth: 1,
    borderColor: colors.border,
    paddingHorizontal: spacing.sm + 4,
    paddingVertical: spacing.sm,
    marginTop: 4,
    marginBottom: spacing.sm,
  },
  pickerLabel: {
    flexShrink: 1,
  },
  pickerList: {
    gap: spacing.sm,
    marginBottom: spacing.sm,
  },
  pickerScroll: {
    maxHeight: 220,
  },
  pickerRow: {
    paddingVertical: spacing.sm,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
  cardPad: {
    paddingHorizontal: spacing.md,
    paddingTop: spacing.md,
  },
  noMargin: {
    marginBottom: 0,
  },
  toggleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm + 2,
  },
  toggleText: {
    flex: 1,
    gap: 1,
  },
  buttonRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.sm,
    marginTop: spacing.sm,
  },
  confirm: {
    gap: spacing.xs,
    marginTop: spacing.sm,
  },
});
