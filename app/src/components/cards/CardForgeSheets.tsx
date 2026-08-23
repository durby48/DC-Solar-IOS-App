import Ionicons from '@expo/vector-icons/Ionicons';
import { useRouter } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  TextInput,
  useWindowDimensions,
  View,
} from 'react-native';

import { TradingCard } from '@/components/cards/TradingCard';
import { AnimatedPressable, AppText, Button, Card, Chip } from '@/components/ui';
import { colors, radii, shadows, spacing } from '@/constants/theme';
import {
  CARD_DRAFT_PARAM,
  CARD_RARITIES,
  CARD_TYPES,
  cardTypeLabel,
  draftCard,
  draftToCardInput,
  draftToCardRecord,
  fetchForgeExamples,
  rarityLabel,
  regenerateCardArt,
  saveCard,
  stashCardDraft,
  syncJobsToCards,
  type CardDraft,
  type CardRarity,
  type CardType,
  type ForgeSkip,
  type ForgedCard,
} from '@/lib/cards';
import * as haptics from '@/lib/haptics';
import { useMotion } from '@/lib/motion';

/**
 * THE CARD FORGE — the two admin tools that sit in the catalog toolbar.
 *
 * Everything in this file talks to the `card-forge` edge function, and both
 * sheets are built around one belief: THE MODEL PROPOSES, A PERSON PUBLISHES.
 * Neither tool ever writes a card the admin hasn't seen first. "Sync jobs"
 * previews the exact list before the button that creates it says a number,
 * and "New card from a prompt" hands back a draft that is not in the database
 * until somebody presses Save.
 *
 * The second belief is that GENERATING ART COSTS REAL MONEY — about four
 * cents a card against Devon's Gemini key. So the art switch is off by
 * default, its price is printed on it, and a dry run never draws anything at
 * all. Twenty-five cards is a dollar; that should be a decision, not a
 * default.
 *
 * A forge call can take 10–40 seconds. Every busy state therefore says how
 * long it has been waiting, because a spinner with no clock on it is how you
 * get a second press.
 */

// ---------------------------------------------------------------------------
// Shared shell
// ---------------------------------------------------------------------------

const SCRIM = 'rgba(61,53,46,0.45)';

/**
 * The bottom sheet these two tools share.
 *
 * Same shape as `WheelPickerSheet` — dark scrim, a grip, a 520px cap so a
 * desktop browser doesn't get a mile of white — with the body in a ScrollView
 * because a results list of twenty-five cards is taller than a phone.
 */
function Sheet({
  visible,
  title,
  subtitle,
  onClose,
  children,
  footer,
}: {
  visible: boolean;
  title: string;
  subtitle?: string;
  onClose: () => void;
  children: React.ReactNode;
  footer?: React.ReactNode;
}) {
  const motion = useMotion();
  return (
    <Modal
      visible={visible}
      transparent
      animationType={motion.enabled ? 'slide' : 'none'}
      statusBarTranslucent
      onRequestClose={onClose}>
      <View style={styles.scrimRoot}>
        <Pressable
          style={StyleSheet.absoluteFill}
          onPress={onClose}
          accessibilityRole="button"
          accessibilityLabel={`Close ${title}`}
        />
        <View style={styles.sheet}>
          <View style={styles.grip} />
          <View style={styles.sheetHead}>
            <View style={styles.sheetHeadText}>
              <AppText variant="heading">{title}</AppText>
              {subtitle ? (
                <AppText variant="caption" color={colors.textMuted}>
                  {subtitle}
                </AppText>
              ) : null}
            </View>
            <AnimatedPressable
              onPress={onClose}
              haptic="tapLight"
              hitSlop={10}
              accessibilityRole="button"
              accessibilityLabel="Close">
              <Ionicons name="close" size={22} color={colors.textMuted} />
            </AnimatedPressable>
          </View>
          <ScrollView
            style={styles.sheetScroll}
            contentContainerStyle={styles.sheetBody}
            keyboardShouldPersistTaps="handled">
            {children}
          </ScrollView>
          {footer ? <View style={styles.sheetFooter}>{footer}</View> : null}
        </View>
      </View>
    </Modal>
  );
}

/** A red card that says exactly what went wrong. Null when nothing did. */
function ErrorNote({ message }: { message: string | null }) {
  if (!message) return null;
  return (
    <Card tone="danger" style={styles.note}>
      <View style={styles.noteRow}>
        <Ionicons name="alert-circle" size={16} color={colors.danger} />
        <AppText variant="bodyStrong" color={colors.danger} style={styles.noteText}>
          {message}
        </AppText>
      </View>
    </Card>
  );
}

/**
 * A spinner that admits how long it has been spinning.
 *
 * Gemini takes ten to forty seconds and occasionally longer. Without the
 * count the honest read of this screen is "it's stuck", and the honest
 * response is to press the button again — which on the create path would
 * bill a second run.
 */
function BusyNote({ label, since }: { label: string; since: number | null }) {
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    if (since == null) {
      setElapsed(0);
      return;
    }
    setElapsed(Math.max(0, Math.round((Date.now() - since) / 1000)));
    const timer = setInterval(() => {
      setElapsed(Math.max(0, Math.round((Date.now() - since) / 1000)));
    }, 1000);
    return () => clearInterval(timer);
  }, [since]);

  return (
    <Card tone="sunk" style={styles.note}>
      <View style={styles.noteRow}>
        <ActivityIndicator color={colors.accentPrimary} />
        <AppText variant="body" color={colors.textSecondary} style={styles.noteText}>
          {label}
          {since != null ? ` — ${elapsed}s` : ''}
        </AppText>
      </View>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Row renderers — exported so a preview harness can feed them sample data
// ---------------------------------------------------------------------------

/** The stat pills a job card prints, by `cardStats`' rules for job/special. */
function forgedStats(card: ForgedCard): string[] {
  const out: string[] = [];
  if (card.panels != null) out.push(`${card.panels} panels`);
  if (card.kw_dc != null) out.push(`${card.kw_dc} kWdc`);
  if (card.annual_kwh != null) out.push(`${card.annual_kwh.toLocaleString()} kWh/yr`);
  if (card.difficulty != null) out.push(`DIFF ${card.difficulty}`);
  if (card.reward_kw != null) out.push(`+${card.reward_kw} kW`);
  return out;
}

const ART_NOTE: Record<'ready' | 'skipped' | 'failed', { icon: 'image' | 'remove-circle-outline' | 'warning'; label: string; color: string }> = {
  ready: { icon: 'image', label: 'Art drawn', color: colors.mintDeep },
  skipped: { icon: 'remove-circle-outline', label: 'No art', color: colors.textMuted },
  failed: { icon: 'warning', label: 'Art failed', color: colors.amberDeep },
};

/**
 * One planned or created card.
 *
 * `art` is only printed when the response actually reported it — a dry run
 * has nothing to say about artwork and pretending otherwise ("No art") would
 * read as a decision the server made rather than a question it wasn't asked.
 */
export function ForgedCardRow({ card }: { card: ForgedCard }) {
  const stats = forgedStats(card);
  const art = card.art ? ART_NOTE[card.art] : null;
  return (
    <View style={styles.row}>
      <View style={styles.rowHead}>
        <AppText variant="bodyStrong" numberOfLines={1} style={styles.rowTitle}>
          {card.title || card.id}
        </AppText>
        <AppText variant="caption" color={colors.textMuted}>
          {card.job_number ?? card.card_type.toUpperCase()}
        </AppText>
      </View>
      <View style={styles.rowMeta}>
        <View style={[styles.rarityDot, { backgroundColor: RARITY_DOT[card.rarity] }]} />
        <AppText variant="caption" color={colors.textSecondary}>
          {rarityLabel(card.rarity)} {cardTypeLabel(card.card_type).toLowerCase()}
        </AppText>
        {card.location ? (
          <AppText variant="caption" color={colors.textMuted} numberOfLines={1}>
            · {card.location}
          </AppText>
        ) : null}
      </View>
      {stats.length > 0 ? (
        <AppText variant="caption" color={colors.textMuted}>
          {stats.join(' · ')}
        </AppText>
      ) : null}
      {art ? (
        <View style={styles.artRow}>
          <Ionicons name={art.icon} size={13} color={art.color} />
          <AppText variant="caption" color={art.color}>
            {art.label}
          </AppText>
        </View>
      ) : null}
    </View>
  );
}

/** One job the forge passed over. The reason is the whole point of the row. */
export function ForgeSkipRow({ skip }: { skip: ForgeSkip }) {
  return (
    <View style={styles.skipRow}>
      <Ionicons name="arrow-forward-circle-outline" size={15} color={colors.textMuted} />
      <View style={styles.skipBody}>
        <AppText variant="bodyStrong" color={colors.textSecondary}>
          {skip.jobNumber}
        </AppText>
        <AppText variant="caption" color={colors.textMuted}>
          {skip.reason}
        </AppText>
      </View>
    </View>
  );
}

const RARITY_DOT: Record<CardRarity, string> = {
  common: '#5d6b79',
  uncommon: '#157a39',
  rare: '#1f5fbf',
  legendary: '#b5721a',
  secret: '#7a3fb5',
};

/**
 * The created / planned list, with its skips underneath.
 *
 * Both halves are always drawn. A run that made four cards and skipped nine
 * is mostly a report about the nine.
 */
export function ForgeCardList({
  created,
  skipped,
  emptyLabel,
}: {
  created: ForgedCard[];
  skipped: ForgeSkip[];
  emptyLabel: string;
}) {
  return (
    <>
      {created.length === 0 ? (
        <Card tone="sunk" style={styles.note}>
          <AppText variant="body" color={colors.textSecondary}>
            {emptyLabel}
          </AppText>
        </Card>
      ) : (
        <Card padded={false} style={styles.listCard}>
          {created.map((card, index) => (
            <View key={card.id || `${card.title}-${index}`} style={index > 0 ? styles.divided : null}>
              <ForgedCardRow card={card} />
            </View>
          ))}
        </Card>
      )}

      {skipped.length > 0 ? (
        <>
          <AppText variant="caption" color={colors.textMuted} style={styles.listLabel}>
            {skipped.length === 1 ? '1 job skipped' : `${skipped.length} jobs skipped`}
          </AppText>
          <Card tone="sunk" padded={false} style={styles.listCard}>
            {skipped.map((skip, index) => (
              <View
                key={`${skip.jobNumber}-${index}`}
                style={index > 0 ? styles.divided : null}>
                <ForgeSkipRow skip={skip} />
              </View>
            ))}
          </Card>
        </>
      ) : null}
    </>
  );
}

// ---------------------------------------------------------------------------
// Sync jobs → cards
// ---------------------------------------------------------------------------

type SyncPhase = 'idle' | 'previewing' | 'creating';

interface SyncOutcome {
  created: ForgedCard[];
  skipped: ForgeSkip[];
  more: boolean;
}

/**
 * "Sync jobs → cards": give every card-less project a card.
 *
 * PREVIEW IS NOT OPTIONAL — the create button is disabled until there is a
 * plan, and it says how many cards it is about to make. That number comes
 * from the server's own dry run, not from a client-side count of anything, so
 * "Create 12 cards" means twelve.
 */
export function SyncJobsSheet({
  visible,
  onClose,
  onCreated,
}: {
  visible: boolean;
  onClose: () => void;
  /** Refresh the catalog behind the sheet. Fired once, after a real run. */
  onCreated: () => void;
}) {
  const [phase, setPhase] = useState<SyncPhase>('idle');
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const [plan, setPlan] = useState<SyncOutcome | null>(null);
  const [outcome, setOutcome] = useState<SyncOutcome | null>(null);
  const [generateArt, setGenerateArt] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const busy = phase !== 'idle';

  const reset = useCallback(() => {
    setPhase('idle');
    setStartedAt(null);
    setPlan(null);
    setOutcome(null);
    setError(null);
  }, []);

  // A closed sheet forgets everything. Reopening it against a plan computed
  // before somebody else added three jobs would put a stale number on the
  // create button, and that number is the whole promise of the preview.
  useEffect(() => {
    if (!visible) reset();
  }, [visible, reset]);

  const onPreview = async () => {
    setError(null);
    setOutcome(null);
    setPhase('previewing');
    setStartedAt(Date.now());
    const result = await syncJobsToCards({ dryRun: true });
    setPhase('idle');
    setStartedAt(null);
    if (!result.ok) {
      setPlan(null);
      setError(result.message);
      return;
    }
    setPlan({ created: result.created, skipped: result.skipped, more: result.more });
  };

  const onCreate = async () => {
    setError(null);
    setPhase('creating');
    setStartedAt(Date.now());
    const result = await syncJobsToCards({ dryRun: false, generateArt });
    setPhase('idle');
    setStartedAt(null);
    if (!result.ok) {
      setError(result.message);
      return;
    }
    setOutcome({ created: result.created, skipped: result.skipped, more: result.more });
    setPlan(null);
    haptics.success();
    onCreated();
  };

  const planned = plan?.created.length ?? 0;
  const madeCount = outcome?.created.length ?? 0;

  return (
    <Sheet
      visible={visible}
      title="Sync jobs to cards"
      subtitle="Every project, eventually, becomes a card."
      onClose={onClose}
      footer={
        outcome ? (
          <Button label="Done" fullWidth onPress={onClose} />
        ) : (
          <View style={styles.footerRow}>
            <Button
              label={plan ? 'Preview again' : 'Preview'}
              icon="eye-outline"
              variant="secondary"
              size="sm"
              loading={phase === 'previewing'}
              disabled={busy}
              onPress={() => void onPreview()}
              style={styles.footerButton}
            />
            <Button
              label={planned > 0 ? `Create ${planned} card${planned === 1 ? '' : 's'}` : 'Create cards'}
              icon="hammer-outline"
              size="sm"
              loading={phase === 'creating'}
              disabled={busy || !plan || planned === 0}
              onPress={() => void onCreate()}
              style={styles.footerButton}
            />
          </View>
        )
      }>
      <AppText variant="body" color={colors.textSecondary}>
        Creates a job card for every project that doesn&apos;t have one yet. New projects get cards
        progressively — run this any time.
      </AppText>

      <View style={styles.toggleRow}>
        <View style={styles.toggleText}>
          <AppText variant="bodyStrong">Also generate artwork</AppText>
          <AppText variant="caption" color={colors.textMuted}>
            About 4¢ per card, drawn by Gemini. Off by default — you can add art card by card in
            the editor later.
          </AppText>
        </View>
        <Switch
          value={generateArt}
          onValueChange={setGenerateArt}
          disabled={busy}
          trackColor={{ false: colors.border, true: colors.oliveMid }}
          thumbColor={colors.surface}
          accessibilityLabel="Also generate artwork"
        />
      </View>

      <ErrorNote message={error} />

      {phase === 'previewing' ? (
        <BusyNote label="Working out which jobs still need a card" since={startedAt} />
      ) : null}
      {phase === 'creating' ? (
        <BusyNote
          label={
            generateArt
              ? 'Writing the cards and drawing them — this can take 10–40 seconds a card'
              : 'Writing the cards'
          }
          since={startedAt}
        />
      ) : null}

      {outcome ? (
        <>
          <Card tone="sunk" style={styles.note}>
            <AppText variant="bodyStrong" color={colors.oliveDeep}>
              {madeCount === 0
                ? 'Nothing to create — every job already has a card.'
                : outcome.more
                  ? `${madeCount} created — run again for the rest.`
                  : `${madeCount} card${madeCount === 1 ? '' : 's'} created. They are live in packs now.`}
            </AppText>
          </Card>
          <ForgeCardList
            created={outcome.created}
            skipped={outcome.skipped}
            emptyLabel="No cards were created."
          />
        </>
      ) : plan ? (
        <>
          <AppText variant="caption" color={colors.textMuted} style={styles.listLabel}>
            {planned === 0
              ? 'Nothing to create'
              : `${planned} card${planned === 1 ? '' : 's'} would be created`}
            {plan.more ? ' (the first batch — run it again afterwards)' : ''}
          </AppText>
          <ForgeCardList
            created={plan.created}
            skipped={plan.skipped}
            emptyLabel="Every job already has a card. Nothing to do."
          />
        </>
      ) : !busy && !error ? (
        <Card tone="sunk" style={styles.note}>
          <AppText variant="body" color={colors.textSecondary}>
            Press Preview to see exactly which cards would be made. Nothing is saved until you
            press Create.
          </AppText>
        </Card>
      ) : null}
    </Sheet>
  );
}

// ---------------------------------------------------------------------------
// New card from a prompt
// ---------------------------------------------------------------------------

/** The draft, drawn as the card it would be, plus the fields behind it. */
export function DraftPreview({ draft, width }: { draft: CardDraft; width: number }) {
  const record = draftToCardRecord(draft);
  const rows: { label: string; value: string }[] = [
    { label: 'Type', value: cardTypeLabel(draft.card_type) },
    { label: 'Rarity', value: rarityLabel(draft.rarity) },
  ];
  if (draft.job_number) rows.push({ label: 'Job number', value: draft.job_number });
  if (draft.service_type) rows.push({ label: 'Service', value: draft.service_type });
  if (draft.location) rows.push({ label: 'Location', value: draft.location });
  if (draft.panels != null) rows.push({ label: 'Panels', value: String(draft.panels) });
  if (draft.kw_dc != null) rows.push({ label: 'kWdc', value: String(draft.kw_dc) });
  if (draft.annual_kwh != null) {
    rows.push({ label: 'Annual kWh', value: draft.annual_kwh.toLocaleString() });
  }
  if (draft.difficulty != null) rows.push({ label: 'Difficulty', value: String(draft.difficulty) });
  if (draft.reward_kw != null) rows.push({ label: 'Reward kW', value: String(draft.reward_kw) });
  if (draft.role) rows.push({ label: 'Role', value: draft.role });
  // Power 0 is a real rating — The Inspector genuinely contributes nothing.
  if (draft.power != null) rows.push({ label: 'Power', value: String(draft.power) });
  if (draft.bonus != null) rows.push({ label: 'Bonus', value: String(draft.bonus) });
  if (draft.ability) rows.push({ label: 'Ability', value: draft.ability });
  if (draft.flavor) rows.push({ label: 'Flavor', value: draft.flavor });
  if (draft.art_prompt) rows.push({ label: 'Art prompt', value: draft.art_prompt });

  return (
    <>
      <View style={styles.draftStage}>
        <TradingCard
          card={record}
          artUrl={null}
          variant={draft.holo_only ? 'holo' : 'base'}
          width={width}
        />
      </View>
      <Card padded={false} style={styles.listCard}>
        {rows.map((row, index) => (
          <View key={row.label} style={[styles.fieldRow, index > 0 ? styles.divided : null]}>
            <AppText variant="caption" color={colors.textMuted} style={styles.fieldLabel}>
              {row.label}
            </AppText>
            <AppText variant="body" style={styles.fieldValue}>
              {row.value}
            </AppText>
          </View>
        ))}
      </Card>
    </>
  );
}

/**
 * "New card from a prompt": a sentence in, a card out.
 *
 * TWO WAYS OUT OF THE DRAFT, on purpose. "Open in editor" is the careful one
 * — the full form, every field, the art buttons — and it is where a card that
 * matters should go. "Save to catalog" is the fast one, for the times an
 * admin is making five cards in a row and the draft came back right; it
 * inserts immediately, which means the card is in packs immediately, and then
 * offers to draw the art.
 *
 * The draft reaches the editor through `stashCardDraft` rather than the URL —
 * see the note on that function about why a card does not belong in a query
 * string.
 */
export function DraftCardSheet({
  visible,
  onClose,
  onSaved,
}: {
  visible: boolean;
  onClose: () => void;
  /** Refresh the catalog behind the sheet. Fired after a direct save. */
  onSaved: () => void;
}) {
  const router = useRouter();
  const { width } = useWindowDimensions();

  const [prompt, setPrompt] = useState('');
  const [cardType, setCardType] = useState<CardType | null>(null);
  const [rarity, setRarity] = useState<CardRarity | null>(null);
  const [keywords, setKeywords] = useState<string[]>([]);
  const [draft, setDraft] = useState<CardDraft | null>(null);
  const [busy, setBusy] = useState(false);
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [savedId, setSavedId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [artBusy, setArtBusy] = useState(false);
  const [artNote, setArtNote] = useState<string | null>(null);

  // The keyword list is a constant behind a request; `fetchForgeExamples`
  // caches it for the session, so this fires once however often the sheet is
  // opened. A failure is silent — the helper line simply isn't drawn.
  const askedForKeywords = useRef(false);
  useEffect(() => {
    if (!visible || askedForKeywords.current) return;
    askedForKeywords.current = true;
    void fetchForgeExamples().then((result) => {
      if (result.ok) setKeywords(result.keywords);
    });
  }, [visible]);

  useEffect(() => {
    if (visible) return;
    // Keep the prompt and the chips — an admin who closed by accident should
    // not have to retype the sentence — but drop everything downstream of it.
    setDraft(null);
    setError(null);
    setSavedId(null);
    setArtNote(null);
    setBusy(false);
    setSaving(false);
    setArtBusy(false);
    setStartedAt(null);
  }, [visible]);

  const onDraft = async () => {
    setError(null);
    setArtNote(null);
    setSavedId(null);
    setBusy(true);
    setStartedAt(Date.now());
    const result = await draftCard({ prompt, cardType, rarity });
    setBusy(false);
    setStartedAt(null);
    if (!result.ok) {
      setDraft(null);
      setError(result.message);
      return;
    }
    setDraft(result.draft);
    haptics.success();
  };

  const onOpenInEditor = () => {
    if (!draft) return;
    stashCardDraft(draft);
    onClose();
    router.push({ pathname: '/cards/editor', params: { [CARD_DRAFT_PARAM]: '1' } });
  };

  const onSaveDirect = async () => {
    if (!draft) return;
    setError(null);
    setSaving(true);
    const result = await saveCard(draftToCardInput(draft));
    setSaving(false);
    if (!result.ok) {
      setError(result.message);
      return;
    }
    setSavedId(result.id);
    haptics.success();
    onSaved();
  };

  const onGenerateArt = async () => {
    if (!savedId) return;
    setArtNote(null);
    setArtBusy(true);
    setStartedAt(Date.now());
    const result = await regenerateCardArt(savedId, true);
    setArtBusy(false);
    setStartedAt(null);
    if (!result.ok) {
      setError(result.message);
      return;
    }
    setArtNote('Artwork drawn.');
    haptics.success();
    onSaved();
  };

  const previewWidth = Math.min(220, width - spacing.lg * 4);
  const canDraft = prompt.trim().length > 0 && !busy;

  return (
    <Sheet
      visible={visible}
      title="New card from a prompt"
      subtitle="A sentence in, a card out. Nothing is saved until you say so."
      onClose={onClose}
      footer={
        draft ? (
          savedId ? (
            <View style={styles.footerRow}>
              <Button
                label="Open in editor"
                icon="create-outline"
                variant="secondary"
                size="sm"
                disabled={artBusy}
                onPress={() => {
                  onClose();
                  router.push({ pathname: '/cards/editor', params: { id: savedId } });
                }}
                style={styles.footerButton}
              />
              <Button
                label="Generate art now"
                icon="sparkles-outline"
                size="sm"
                loading={artBusy}
                disabled={artBusy}
                onPress={() => void onGenerateArt()}
                style={styles.footerButton}
              />
            </View>
          ) : (
            <View style={styles.footerRow}>
              <Button
                label="Save to catalog"
                icon="checkmark"
                variant="secondary"
                size="sm"
                loading={saving}
                disabled={saving}
                onPress={() => void onSaveDirect()}
                style={styles.footerButton}
              />
              <Button
                label="Open in editor"
                icon="create-outline"
                size="sm"
                disabled={saving}
                onPress={onOpenInEditor}
                style={styles.footerButton}
              />
            </View>
          )
        ) : (
          <Button
            label="Draft"
            icon="sparkles-outline"
            fullWidth
            loading={busy}
            disabled={!canDraft}
            onPress={() => void onDraft()}
          />
        )
      }>
      <View style={styles.field}>
        <AppText variant="caption" color={colors.textMuted}>
          Describe the card
        </AppText>
        <TextInput
          value={prompt}
          onChangeText={setPrompt}
          placeholder="Describe the card — who/what it's about, the vibe, how strong"
          placeholderTextColor={colors.textMuted}
          multiline
          editable={!busy}
          style={[styles.input, styles.inputMultiline]}
          accessibilityLabel="Describe the card"
        />
      </View>

      {keywords.length > 0 ? (
        <AppText variant="caption" color={colors.textMuted}>
          Game keywords you can lean on: {keywords.join(' · ')}
        </AppText>
      ) : null}

      <AppText variant="caption" color={colors.textMuted}>
        Type (optional)
      </AppText>
      <View style={styles.chipRow}>
        {CARD_TYPES.map((type) => (
          <Chip
            key={type}
            label={cardTypeLabel(type)}
            tone="olive"
            selected={cardType === type}
            onPress={() => setCardType(cardType === type ? null : type)}
          />
        ))}
      </View>

      <AppText variant="caption" color={colors.textMuted}>
        Rarity (optional)
      </AppText>
      <View style={styles.chipRow}>
        {CARD_RARITIES.map((option) => (
          <Chip
            key={option}
            label={rarityLabel(option)}
            tone="ocean"
            selected={rarity === option}
            onPress={() => setRarity(rarity === option ? null : option)}
          />
        ))}
      </View>

      <ErrorNote message={error} />

      {busy ? <BusyNote label="Writing the card" since={startedAt} /> : null}
      {artBusy ? <BusyNote label="Drawing the artwork" since={startedAt} /> : null}

      {savedId ? (
        <Card tone="sunk" style={styles.note}>
          <AppText variant="bodyStrong" color={colors.oliveDeep}>
            Saved as {savedId}. It is live in packs now.
          </AppText>
          {artNote ? (
            <AppText variant="caption" color={colors.textSecondary}>
              {artNote}
            </AppText>
          ) : null}
        </Card>
      ) : null}

      {draft ? <DraftPreview draft={draft} width={previewWidth} /> : null}
    </Sheet>
  );
}

// ---------------------------------------------------------------------------

const styles = StyleSheet.create({
  scrimRoot: {
    flex: 1,
    justifyContent: 'flex-end',
    backgroundColor: SCRIM,
  },
  sheet: {
    width: '100%',
    maxWidth: 520,
    // A results list of twenty-five cards would otherwise push the footer off
    // the bottom of the screen; the body scrolls inside this cap instead.
    maxHeight: '92%',
    alignSelf: 'center',
    backgroundColor: colors.surface,
    borderTopLeftRadius: radii.lg,
    borderTopRightRadius: radii.lg,
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.sm,
    paddingBottom: spacing.lg,
    gap: spacing.sm,
    ...shadows.raised,
  },
  grip: {
    width: 44,
    height: 4,
    borderRadius: radii.pill,
    backgroundColor: colors.borderStrong,
    alignSelf: 'center',
  },
  sheetHead: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    gap: spacing.sm,
    paddingTop: spacing.xs,
  },
  sheetHeadText: {
    flexShrink: 1,
    gap: 2,
  },
  sheetScroll: {
    // Grow to the content, but SHRINK once the sheet hits its 92% cap — that
    // is what keeps the footer's Create button on screen when a results list
    // runs to twenty-five cards.
    flexGrow: 0,
    flexShrink: 1,
  },
  sheetBody: {
    gap: spacing.sm,
    paddingBottom: spacing.sm,
  },
  sheetFooter: {
    paddingTop: spacing.xs,
  },
  footerRow: {
    flexDirection: 'row',
    gap: spacing.sm,
  },
  footerButton: {
    flex: 1,
  },
  note: {
    gap: spacing.xs,
  },
  noteRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
  },
  noteText: {
    flexShrink: 1,
  },
  toggleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingVertical: spacing.xs,
  },
  toggleText: {
    flex: 1,
    gap: 1,
  },
  listLabel: {
    marginTop: spacing.xs,
  },
  listCard: {
    paddingHorizontal: 0,
  },
  divided: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
  },
  row: {
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    gap: 2,
  },
  rowHead: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.sm,
  },
  rowTitle: {
    flexShrink: 1,
  },
  rowMeta: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs + 2,
  },
  rarityDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  artRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    marginTop: 2,
  },
  skipRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: spacing.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
  },
  skipBody: {
    flexShrink: 1,
    gap: 1,
  },
  field: {
    gap: 4,
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
    minHeight: 96,
    textAlignVertical: 'top',
  },
  chipRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.xs + 2,
  },
  draftStage: {
    alignItems: 'center',
    paddingVertical: spacing.sm,
  },
  fieldRow: {
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    gap: 1,
  },
  fieldLabel: {
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  fieldValue: {
    flexShrink: 1,
  },
});
