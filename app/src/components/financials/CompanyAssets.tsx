import Ionicons from '@expo/vector-icons/Ionicons';
import { useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';

import { Field } from '@/components/forms/Field';
import { AppText, Button, Card, Chip, SectionHeader } from '@/components/ui';
import { colors, fonts, hubColors, radii, spacing } from '@/constants/theme';
import { formatShortDate, todayISO } from '@/lib/dates';
import * as haptics from '@/lib/haptics';
import { isValidISODate } from '@/lib/time';
import {
  assetBookValue,
  DEFAULT_LIFE_YEARS,
  deleteAsset,
  deleteLiability,
  saveAsset,
  saveLiability,
  type AssetCategory,
  type CompanyAsset,
  type CompanyLiability,
  type LiabilityKind,
} from '@/lib/valuation';

import { formatMoney, formatRounded, formatSigned } from './format';

/**
 * Company assets & liabilities — the owner's inputs to the Value line.
 *
 * Two compact lists (vehicles/tools/equipment at book value; loans and credit
 * at face value) with add / edit / delete, and the resulting book value
 * (assets − liabilities) on top. Writes go straight to `company_assets` /
 * `company_liabilities` (admin-only per RLS); the screen refetches on
 * `onChanged`, and the realtime subscription would catch it anyway.
 */

const CATEGORIES: { key: AssetCategory; label: string }[] = [
  { key: 'vehicle', label: 'Vehicle' },
  { key: 'tool', label: 'Tool' },
  { key: 'equipment', label: 'Equipment' },
  { key: 'other', label: 'Other' },
];

const KINDS: { key: LiabilityKind; label: string }[] = [
  { key: 'loan', label: 'Loan' },
  { key: 'credit', label: 'Credit' },
  { key: 'other', label: 'Other' },
];

interface Props {
  assets: CompanyAsset[];
  liabilities: CompanyLiability[];
  onChanged: () => void | Promise<void>;
}

function parseAmount(text: string): number | null {
  const n = Number(text.replace(/[^0-9.]/g, ''));
  return Number.isFinite(n) && n >= 0 ? n : null;
}

export function CompanyAssets({ assets, liabilities, onChanged }: Props) {
  const today = todayISO();
  const [status, setStatus] = useState<{ kind: 'success' | 'error'; message: string } | null>(null);

  const assetsTotal = assets.reduce((sum, a) => sum + assetBookValue(a, today), 0);
  const liabilitiesTotal = liabilities.reduce((sum, l) => sum + l.balance, 0);

  return (
    <View style={styles.wrap}>
      <SectionHeader
        title="Company assets & liabilities"
        subtitle="Vehicles, tools and loans behind the Value line"
        icon="car"
        accent={hubColors.systems.fg}
      />
      <Card style={styles.summary}>
        <View style={styles.summaryRow}>
          <Summary label="Assets (book)" value={assetsTotal} />
          <Summary label="Liabilities" value={-liabilitiesTotal} />
          <Summary label="Net" value={assetsTotal - liabilitiesTotal} strong />
        </View>
      </Card>

      <AssetList assets={assets} today={today} onChanged={onChanged} onStatus={setStatus} />
      <LiabilityList liabilities={liabilities} onChanged={onChanged} onStatus={setStatus} />

      {status ? (
        <AppText
          variant="caption"
          align="center"
          color={status.kind === 'error' ? colors.danger : colors.accentPrimary}
          style={styles.status}>
          {status.message}
        </AppText>
      ) : null}
    </View>
  );
}

function Summary({ label, value, strong }: { label: string; value: number; strong?: boolean }) {
  return (
    <View style={styles.summaryItem}>
      <AppText variant="caption" color={colors.textMuted}>
        {label}
      </AppText>
      <AppText variant={strong ? 'numeric' : 'bodyStrong'} style={styles.num}>
        {formatSigned(value)}
      </AppText>
    </View>
  );
}

type Status = { kind: 'success' | 'error'; message: string } | null;

// ---------------------------------------------------------------------------
// Assets
// ---------------------------------------------------------------------------

function AssetList({
  assets,
  today,
  onChanged,
  onStatus,
}: {
  assets: CompanyAsset[];
  today: string;
  onChanged: () => void | Promise<void>;
  onStatus: (s: Status) => void;
}) {
  const [editing, setEditing] = useState<'new' | string | null>(null);
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const remove = async (asset: CompanyAsset) => {
    if (confirmId !== asset.id) {
      setConfirmId(asset.id);
      return;
    }
    setConfirmId(null);
    setBusy(true);
    const result = await deleteAsset(asset.id);
    setBusy(false);
    if (result.ok) {
      if (editing === asset.id) setEditing(null);
      onStatus({ kind: 'success', message: `${asset.name} removed.` });
      await onChanged();
    } else onStatus({ kind: 'error', message: result.message });
  };

  return (
    <View style={styles.group}>
      <View style={styles.groupHeader}>
        <AppText variant="heading" style={styles.groupTitle}>
          Assets
        </AppText>
        <Button
          label={editing === 'new' ? 'Close' : '+ Add asset'}
          size="sm"
          variant={editing === 'new' ? 'secondary' : 'primary'}
          onPress={() => {
            onStatus(null);
            setEditing(editing === 'new' ? null : 'new');
          }}
        />
      </View>
      {editing === 'new' ? (
        <AssetForm
          onDone={async (message) => {
            setEditing(null);
            onStatus({ kind: 'success', message });
            await onChanged();
          }}
          onError={(message) => onStatus({ kind: 'error', message })}
          onCancel={() => setEditing(null)}
        />
      ) : null}
      {assets.length === 0 && editing !== 'new' ? (
        <Card tone="sunk">
          <AppText variant="caption" color={colors.textMuted} align="center">
            No assets yet. Add the trucks, trailers and tools the company owns — each
            depreciates straight-line to the day and lifts the Value line.
          </AppText>
        </Card>
      ) : null}
      {assets.map((asset) => {
        const book = assetBookValue(asset, today);
        const open = editing === asset.id;
        return (
          <Card key={asset.id} style={styles.row}>
            <Pressable
              style={styles.rowMain}
              onPress={() => {
                onStatus(null);
                setConfirmId(null);
                setEditing(open ? null : asset.id);
              }}
              accessibilityRole="button"
              accessibilityLabel={`${asset.name}, book value ${formatRounded(book)}`}>
              <View style={styles.rowText}>
                <AppText variant="bodyStrong" numberOfLines={1}>
                  {asset.name}
                </AppText>
                <AppText variant="caption" color={colors.textMuted} numberOfLines={1}>
                  {CATEGORIES.find((c) => c.key === asset.category)?.label ?? asset.category} ·
                  bought {formatShortDate(asset.purchaseDate)} · {asset.usefulLifeYears}y life
                  {asset.disposedOn ? ` · disposed ${formatShortDate(asset.disposedOn)}` : ''}
                </AppText>
              </View>
              <View style={styles.rowAmounts}>
                <AppText variant="bodyStrong" style={styles.num}>
                  {formatRounded(book)}
                </AppText>
                <AppText variant="caption" color={colors.textMuted} style={styles.num}>
                  cost {formatRounded(asset.cost)}
                </AppText>
              </View>
              <Pressable
                onPress={() => void remove(asset)}
                disabled={busy}
                hitSlop={8}
                accessibilityRole="button"
                accessibilityLabel={confirmId === asset.id ? 'Confirm delete' : 'Delete asset'}
                style={styles.trash}>
                <Ionicons
                  name={confirmId === asset.id ? 'alert-circle' : 'trash-outline'}
                  size={18}
                  color={colors.danger}
                />
              </Pressable>
            </Pressable>
            {confirmId === asset.id ? (
              <AppText variant="caption" color={colors.danger} style={styles.confirm}>
                Tap the icon again to delete.
              </AppText>
            ) : null}
            {open ? (
              <AssetForm
                asset={asset}
                onDone={async (message) => {
                  setEditing(null);
                  onStatus({ kind: 'success', message });
                  await onChanged();
                }}
                onError={(message) => onStatus({ kind: 'error', message })}
                onCancel={() => setEditing(null)}
              />
            ) : null}
          </Card>
        );
      })}
    </View>
  );
}

function AssetForm({
  asset,
  onDone,
  onError,
  onCancel,
}: {
  asset?: CompanyAsset;
  onDone: (message: string) => void | Promise<void>;
  onError: (message: string) => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState(asset?.name ?? '');
  const [category, setCategory] = useState<AssetCategory>(asset?.category ?? 'tool');
  const [cost, setCost] = useState(asset ? String(asset.cost) : '');
  const [purchaseDate, setPurchaseDate] = useState(asset?.purchaseDate ?? todayISO());
  const [life, setLife] = useState(
    asset ? String(asset.usefulLifeYears) : String(DEFAULT_LIFE_YEARS.tool),
  );
  const [lifeTouched, setLifeTouched] = useState(Boolean(asset));
  const [salvage, setSalvage] = useState(asset && asset.salvageValue > 0 ? String(asset.salvageValue) : '');
  const [disposedOn, setDisposedOn] = useState(asset?.disposedOn ?? '');
  const [saving, setSaving] = useState(false);

  const pickCategory = (next: AssetCategory) => {
    setCategory(next);
    if (!lifeTouched) setLife(String(DEFAULT_LIFE_YEARS[next]));
  };

  const save = async () => {
    const trimmed = name.trim();
    if (trimmed === '') return onError('Give the asset a name.');
    const costValue = parseAmount(cost);
    if (costValue == null || costValue <= 0) return onError('Enter what it cost, greater than zero.');
    if (!isValidISODate(purchaseDate.trim())) return onError('Enter the purchase date as YYYY-MM-DD.');
    const lifeValue = Number(life);
    if (!Number.isFinite(lifeValue) || lifeValue <= 0) return onError('Useful life must be a number of years above zero.');
    const salvageValue = salvage.trim() === '' ? 0 : parseAmount(salvage);
    if (salvageValue == null || salvageValue > costValue) return onError('Salvage value must be between zero and the cost.');
    const disposed = disposedOn.trim();
    if (disposed !== '' && !isValidISODate(disposed)) return onError('Enter the disposal date as YYYY-MM-DD, or leave it blank.');
    setSaving(true);
    const result = await saveAsset(
      {
        name: trimmed,
        category,
        purchaseDate: purchaseDate.trim(),
        cost: costValue,
        usefulLifeYears: lifeValue,
        salvageValue,
        disposedOn: disposed === '' ? null : disposed,
        note: null,
      },
      asset?.id ?? null,
    );
    setSaving(false);
    if (result.ok) {
      haptics.success();
      await onDone(asset ? `${trimmed} updated.` : `${trimmed} added at ${formatMoney(costValue)}.`);
    } else onError(result.message);
  };

  return (
    <View style={styles.form}>
      <Field label="Name" value={name} onChangeText={setName} placeholder="2019 F-250, Milwaukee kit…" />
      <AppText variant="section" color={colors.textMuted}>
        Category
      </AppText>
      <View style={styles.chips}>
        {CATEGORIES.map((c) => (
          <Chip key={c.key} label={c.label} tone="olive" selected={category === c.key} onPress={() => pickCategory(c.key)} />
        ))}
      </View>
      <View style={styles.pair}>
        <Field label="Cost ($)" value={cost} onChangeText={setCost} placeholder="0.00" keyboardType="decimal-pad" style={styles.half} />
        <Field label="Purchased (YYYY-MM-DD)" value={purchaseDate} onChangeText={setPurchaseDate} placeholder={todayISO()} style={styles.half} />
      </View>
      <View style={styles.pair}>
        <Field
          label="Useful life (years)"
          value={life}
          onChangeText={(t) => {
            setLifeTouched(true);
            setLife(t);
          }}
          keyboardType="decimal-pad"
          style={styles.half}
        />
        <Field label="Salvage value ($, optional)" value={salvage} onChangeText={setSalvage} placeholder="0" keyboardType="decimal-pad" style={styles.half} />
      </View>
      <Field label="Disposed on (optional)" value={disposedOn} onChangeText={setDisposedOn} placeholder="Blank while still owned" />
      <View style={styles.formActions}>
        <Button label="Cancel" size="sm" variant="secondary" onPress={onCancel} />
        <Button label={asset ? 'Save' : 'Add asset'} size="sm" loading={saving} onPress={() => void save()} />
      </View>
    </View>
  );
}

// ---------------------------------------------------------------------------
// Liabilities
// ---------------------------------------------------------------------------

function LiabilityList({
  liabilities,
  onChanged,
  onStatus,
}: {
  liabilities: CompanyLiability[];
  onChanged: () => void | Promise<void>;
  onStatus: (s: Status) => void;
}) {
  const [editing, setEditing] = useState<'new' | string | null>(null);
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const remove = async (row: CompanyLiability) => {
    if (confirmId !== row.id) {
      setConfirmId(row.id);
      return;
    }
    setConfirmId(null);
    setBusy(true);
    const result = await deleteLiability(row.id);
    setBusy(false);
    if (result.ok) {
      if (editing === row.id) setEditing(null);
      onStatus({ kind: 'success', message: `${row.name} removed.` });
      await onChanged();
    } else onStatus({ kind: 'error', message: result.message });
  };

  return (
    <View style={styles.group}>
      <View style={styles.groupHeader}>
        <AppText variant="heading" style={styles.groupTitle}>
          Liabilities
        </AppText>
        <Button
          label={editing === 'new' ? 'Close' : '+ Add liability'}
          size="sm"
          variant={editing === 'new' ? 'secondary' : 'primary'}
          onPress={() => {
            onStatus(null);
            setEditing(editing === 'new' ? null : 'new');
          }}
        />
      </View>
      {editing === 'new' ? (
        <LiabilityForm
          onDone={async (message) => {
            setEditing(null);
            onStatus({ kind: 'success', message });
            await onChanged();
          }}
          onError={(message) => onStatus({ kind: 'error', message })}
          onCancel={() => setEditing(null)}
        />
      ) : null}
      {liabilities.length === 0 && editing !== 'new' ? (
        <Card tone="sunk">
          <AppText variant="caption" color={colors.textMuted} align="center">
            Nothing owed on the books. Add a vehicle loan or a credit line and its balance
            comes off the Value line.
          </AppText>
        </Card>
      ) : null}
      {liabilities.map((row) => {
        const open = editing === row.id;
        return (
          <Card key={row.id} style={styles.row}>
            <Pressable
              style={styles.rowMain}
              onPress={() => {
                onStatus(null);
                setConfirmId(null);
                setEditing(open ? null : row.id);
              }}
              accessibilityRole="button"
              accessibilityLabel={`${row.name}, balance ${formatRounded(row.balance)}`}>
              <View style={styles.rowText}>
                <AppText variant="bodyStrong" numberOfLines={1}>
                  {row.name}
                </AppText>
                <AppText variant="caption" color={colors.textMuted} numberOfLines={1}>
                  {KINDS.find((k) => k.key === row.kind)?.label ?? row.kind} · as of{' '}
                  {formatShortDate(row.asOf)}
                  {row.monthlyPayment != null ? ` · ${formatRounded(row.monthlyPayment)}/mo` : ''}
                </AppText>
              </View>
              <View style={styles.rowAmounts}>
                <AppText variant="bodyStrong" color={colors.danger} style={styles.num}>
                  {formatSigned(-row.balance)}
                </AppText>
              </View>
              <Pressable
                onPress={() => void remove(row)}
                disabled={busy}
                hitSlop={8}
                accessibilityRole="button"
                accessibilityLabel={confirmId === row.id ? 'Confirm delete' : 'Delete liability'}
                style={styles.trash}>
                <Ionicons
                  name={confirmId === row.id ? 'alert-circle' : 'trash-outline'}
                  size={18}
                  color={colors.danger}
                />
              </Pressable>
            </Pressable>
            {confirmId === row.id ? (
              <AppText variant="caption" color={colors.danger} style={styles.confirm}>
                Tap the icon again to delete.
              </AppText>
            ) : null}
            {open ? (
              <LiabilityForm
                liability={row}
                onDone={async (message) => {
                  setEditing(null);
                  onStatus({ kind: 'success', message });
                  await onChanged();
                }}
                onError={(message) => onStatus({ kind: 'error', message })}
                onCancel={() => setEditing(null)}
              />
            ) : null}
          </Card>
        );
      })}
    </View>
  );
}

function LiabilityForm({
  liability,
  onDone,
  onError,
  onCancel,
}: {
  liability?: CompanyLiability;
  onDone: (message: string) => void | Promise<void>;
  onError: (message: string) => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState(liability?.name ?? '');
  const [kind, setKind] = useState<LiabilityKind>(liability?.kind ?? 'loan');
  const [balance, setBalance] = useState(liability ? String(liability.balance) : '');
  const [asOf, setAsOf] = useState(liability?.asOf ?? todayISO());
  const [monthly, setMonthly] = useState(
    liability?.monthlyPayment != null ? String(liability.monthlyPayment) : '',
  );
  const [saving, setSaving] = useState(false);

  const save = async () => {
    const trimmed = name.trim();
    if (trimmed === '') return onError('Give the liability a name.');
    const balanceValue = parseAmount(balance);
    if (balanceValue == null) return onError('Enter the balance owed (zero is fine once it is paid off).');
    if (!isValidISODate(asOf.trim())) return onError('Enter the as-of date as YYYY-MM-DD.');
    const monthlyValue = monthly.trim() === '' ? null : parseAmount(monthly);
    if (monthly.trim() !== '' && monthlyValue == null) return onError('Monthly payment must be a number.');
    setSaving(true);
    const result = await saveLiability(
      {
        name: trimmed,
        kind,
        balance: balanceValue,
        asOf: asOf.trim(),
        monthlyPayment: monthlyValue,
        note: null,
      },
      liability?.id ?? null,
    );
    setSaving(false);
    if (result.ok) {
      haptics.success();
      await onDone(liability ? `${trimmed} updated.` : `${trimmed} added.`);
    } else onError(result.message);
  };

  return (
    <View style={styles.form}>
      <Field label="Name" value={name} onChangeText={setName} placeholder="Truck loan, business card…" />
      <AppText variant="section" color={colors.textMuted}>
        Kind
      </AppText>
      <View style={styles.chips}>
        {KINDS.map((k) => (
          <Chip key={k.key} label={k.label} tone="olive" selected={kind === k.key} onPress={() => setKind(k.key)} />
        ))}
      </View>
      <View style={styles.pair}>
        <Field label="Balance owed ($)" value={balance} onChangeText={setBalance} placeholder="0.00" keyboardType="decimal-pad" style={styles.half} />
        <Field label="As of (YYYY-MM-DD)" value={asOf} onChangeText={setAsOf} placeholder={todayISO()} style={styles.half} />
      </View>
      <Field label="Monthly payment ($, optional)" value={monthly} onChangeText={setMonthly} placeholder="0.00" keyboardType="decimal-pad" />
      <View style={styles.formActions}>
        <Button label="Cancel" size="sm" variant="secondary" onPress={onCancel} />
        <Button label={liability ? 'Save' : 'Add liability'} size="sm" loading={saving} onPress={() => void save()} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    marginTop: spacing.lg,
  },
  summary: {
    marginBottom: spacing.md,
    borderWidth: 1,
    borderColor: hubColors.systems.fg,
  },
  summaryRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    gap: spacing.md,
  },
  summaryItem: {
    flex: 1,
    gap: 2,
  },
  num: {
    fontVariant: ['tabular-nums'],
  },
  group: {
    marginBottom: spacing.md,
    gap: spacing.sm,
  },
  groupHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.sm,
  },
  groupTitle: {
    flex: 1,
  },
  row: {
    paddingVertical: spacing.sm,
  },
  rowMain: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
  },
  rowText: {
    flex: 1,
    gap: 2,
  },
  rowAmounts: {
    alignItems: 'flex-end',
    gap: 2,
  },
  trash: {
    padding: spacing.xs,
    borderRadius: radii.sm,
  },
  confirm: {
    marginTop: spacing.xs,
    fontFamily: fonts.medium,
  },
  form: {
    marginTop: spacing.sm,
    paddingTop: spacing.sm,
    borderTopWidth: 1,
    borderTopColor: colors.border,
  },
  chips: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.xs,
    marginBottom: spacing.sm,
  },
  pair: {
    flexDirection: 'row',
    gap: spacing.sm,
  },
  half: {
    flex: 1,
  },
  formActions: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    gap: spacing.sm,
    marginTop: spacing.xs,
  },
  status: {
    marginTop: spacing.xs,
  },
});
