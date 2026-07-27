import Ionicons from '@expo/vector-icons/Ionicons';
import * as Print from 'expo-print';
import { Stack, router, useLocalSearchParams } from 'expo-router';
import { useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';

import { colors, radii, shadows, spacing } from '@/constants/theme';
import { fetchJob } from '@/lib/data';
import { todayISO } from '@/lib/dates';
import {
  buildDocumentHtml,
  insertDocumentEntry,
  lineItemsTotal,
  nextDocumentNumber,
  uploadGeneratedPdf,
  type DocumentType,
  type LineItem,
} from '@/lib/documents';
import { type Job } from '@/lib/mockData';
import { shareLocalPdf } from '@/lib/pdf';
import { getRole, type RoleInfo } from '@/lib/role';

interface ItemRow {
  key: number;
  name: string;
  qty: string;
  rate: string;
  /** Row added by the Supplement checkbox — carries the warranty description. */
  supplement?: boolean;
}

/**
 * Prefilled "Supplement" estimate line item (racking & railing warranty).
 * Devon adjusts the quantity per estimate; the price is per panel.
 */
const SUPPLEMENT_NAME = 'Supplement';
const SUPPLEMENT_RATE = '136';
const SUPPLEMENT_DESCRIPTION =
  'Replacement of Racking & Railing for modules. Removing the racking and railing voids ' +
  'the manufacturers warranty on the installed racking, railing, and mounting hardware. ' +
  'In order to maintain the warranty, new racking and railing must be supplied for this ' +
  'system. Pricing is listed per panel.';

function formatMoney(amount: number): string {
  return `$${amount.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function parseNum(value: string): number {
  const n = Number(value.replace(/[^0-9.]/g, ''));
  return Number.isFinite(n) ? n : 0;
}

const DEFAULT_NOTES: Record<DocumentType, string> = {
  invoice: 'Due upon receipt. Thank you for your business!',
  estimate: 'Estimate valid for 30 days.',
};

export default function DocumentBuilderScreen() {
  const params = useLocalSearchParams<{ jobId?: string; type?: string }>();
  const jobId = typeof params.jobId === 'string' ? params.jobId : '';
  const type: DocumentType = params.type === 'estimate' ? 'estimate' : 'invoice';
  const typeLabel = type === 'invoice' ? 'Invoice' : 'Estimate';

  const [role, setRole] = useState<RoleInfo | null | 'loading'>('loading');
  const [job, setJob] = useState<Job | null>(null);
  const [jobLoading, setJobLoading] = useState(true);
  const [docNumber, setDocNumber] = useState<string | null>(null);

  const [items, setItems] = useState<ItemRow[]>([{ key: 1, name: '', qty: '1', rate: '' }]);
  const [nextKey, setNextKey] = useState(2);
  const [notes, setNotes] = useState(DEFAULT_NOTES[type]);

  const [phase, setPhase] = useState<'editing' | 'creating' | 'done'>('editing');
  const [error, setError] = useState<string | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [localPdfUri, setLocalPdfUri] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    getRole().then((info) => {
      if (!cancelled) setRole(info);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    if (!jobId) {
      setJobLoading(false);
      return;
    }
    fetchJob(jobId).then((result) => {
      if (cancelled) return;
      setJob(result);
      setJobLoading(false);
      if (result?.job_number) {
        nextDocumentNumber(result.id, result.job_number, type).then((num) => {
          if (!cancelled) setDocNumber(num);
        });
      } else if (result) {
        setDocNumber(`${result.id.slice(0, 8)}-${type === 'invoice' ? 'Invoice' : 'Estimate'}`);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [jobId, type]);

  const total = useMemo(
    () => items.reduce((sum, row) => sum + parseNum(row.qty) * parseNum(row.rate), 0),
    [items],
  );

  const updateItem = (key: number, patch: Partial<ItemRow>) => {
    setItems((prev) => prev.map((row) => (row.key === key ? { ...row, ...patch } : row)));
  };

  const addItem = () => {
    setItems((prev) => [...prev, { key: nextKey, name: '', qty: '1', rate: '' }]);
    setNextKey((k) => k + 1);
  };

  const removeItem = (key: number) => {
    setItems((prev) => (prev.length > 1 ? prev.filter((row) => row.key !== key) : prev));
  };

  const supplementOn = items.some((row) => row.supplement);

  const toggleSupplement = () => {
    if (supplementOn) {
      setItems((prev) =>
        prev.length > 1 || !prev.every((row) => row.supplement)
          ? prev.filter((row) => !row.supplement)
          : prev,
      );
      return;
    }
    setItems((prev) => [
      ...prev,
      {
        key: nextKey,
        name: SUPPLEMENT_NAME,
        qty: '1',
        rate: SUPPLEMENT_RATE,
        supplement: true,
      },
    ]);
    setNextKey((k) => k + 1);
  };

  const create = async () => {
    if (!job || !docNumber) return;
    setError(null);
    setWarnings([]);

    const lineItems: LineItem[] = items
      .filter((row) => row.name.trim().length > 0)
      .map((row) => ({
        name: row.name.trim(),
        ...(row.supplement ? { description: SUPPLEMENT_DESCRIPTION } : {}),
        qty: parseNum(row.qty),
        rate: parseNum(row.rate),
      }));
    if (lineItems.length === 0) {
      setError('Add at least one line item with a name.');
      return;
    }
    if (lineItems.some((item) => item.qty <= 0)) {
      setError('Every line item needs a quantity greater than zero.');
      return;
    }

    const customerName = job.customer?.name ?? 'Customer';
    const occurredOn = todayISO();
    const amount = lineItemsTotal(lineItems);
    const html = buildDocumentHtml({
      type,
      documentNumber: docNumber,
      dateISO: occurredOn,
      customerName,
      customerAddress: job.customer?.address,
      customerEmail: job.customer?.email,
      customerPhone: job.customer?.phone,
      jobNumber: job.job_number,
      jobName: job.name,
      jobAddress: job.address,
      lineItems,
      notes: notes.trim() || null,
    });

    setPhase('creating');
    try {
      if (Platform.OS === 'web') {
        const printable = html.replace(
          '</body>',
          '<script>setTimeout(function(){window.print();},400);</script></body>',
        );
        const win = typeof window !== 'undefined' ? window.open('', '_blank') : null;
        if (win) {
          win.document.write(printable);
          win.document.close();
        } else {
          setWarnings((prev) => [
            ...prev,
            'Could not open the print window (popup blocked?). The entry was still recorded.',
          ]);
        }
        const insert = await insertDocumentEntry({
          type,
          amount,
          counterparty: customerName,
          description: `${typeLabel} ${docNumber}`,
          occurredOn,
          jobId: job.id,
          customerId: job.customer_id,
          documentNumber: docNumber,
          documentPath: null,
          lineItems,
        });
        if (!insert.ok) {
          setError(`The ${type} entry could not be saved: ${insert.message}`);
          setPhase('editing');
          return;
        }
        setPhase('done');
        return;
      }

      const { uri } = await Print.printToFileAsync({ html });
      setLocalPdfUri(uri);

      const upload = await uploadGeneratedPdf({
        jobId: job.id,
        documentNumber: docNumber,
        type,
        localUri: uri,
      });
      if (!upload.ok) {
        setWarnings((prev) => [
          ...prev,
          `The cloud copy failed to save (${upload.message}). You can still share the PDF below.`,
        ]);
      }

      const insert = await insertDocumentEntry({
        type,
        amount,
        counterparty: customerName,
        description: `${typeLabel} ${docNumber}`,
        occurredOn,
        jobId: job.id,
        customerId: job.customer_id,
        documentNumber: docNumber,
        documentPath: upload.ok ? upload.storagePath : null,
        lineItems,
      });
      if (!insert.ok) {
        setWarnings((prev) => [
          ...prev,
          `The ${type} entry could not be recorded (${insert.message}). The PDF is still available to share below.`,
        ]);
      }
      setPhase('done');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not create the PDF. Please try again.');
      setPhase('editing');
    }
  };

  const sharePdf = async () => {
    if (!localPdfUri) return;
    // Copy under the real document name first — the printer's temp file has
    // a random UUID name that would otherwise show up in the share sheet.
    const shared = await shareLocalPdf(localPdfUri, `${docNumber ?? 'document'}.pdf`);
    if (!shared) setError('Sharing is not available on this device.');
  };

  const screenTitle = `New ${type}`;

  if (role === 'loading' || jobLoading) {
    return (
      <>
        <Stack.Screen options={{ title: screenTitle }} />
        <View style={styles.center}>
          <ActivityIndicator color={colors.ocean} />
        </View>
      </>
    );
  }

  if (!role || !role.isAdmin) {
    return (
      <>
        <Stack.Screen options={{ title: screenTitle }} />
        <View style={styles.center}>
          <Ionicons name="lock-closed" size={28} color={colors.inkSoft} />
          <Text style={styles.blockText}>
            Estimates and invoices are only available to admins. Please sign in with an admin
            account.
          </Text>
        </View>
      </>
    );
  }

  if (!job) {
    return (
      <>
        <Stack.Screen options={{ title: screenTitle }} />
        <View style={styles.center}>
          <Text style={styles.blockText}>Job not found.</Text>
        </View>
      </>
    );
  }

  return (
    <>
      <Stack.Screen options={{ title: screenTitle }} />
      <ScrollView
        style={styles.safe}
        contentContainerStyle={styles.container}
        keyboardShouldPersistTaps="handled">
        <View style={styles.headerCard}>
          <Text style={styles.headerType}>{typeLabel}</Text>
          <Text style={styles.headerJob}>
            {job.job_number ? `${job.job_number} · ` : ''}
            {job.name}
          </Text>
          {job.customer?.name ? (
            <Text style={styles.headerCustomer}>{job.customer.name}</Text>
          ) : null}
          <Text style={styles.headerNumber}>{docNumber ?? '…'}</Text>
        </View>

        {phase === 'done' ? (
          <View style={styles.doneCard}>
            <Ionicons name="checkmark-circle" size={30} color={colors.ocean} />
            <Text style={styles.doneTitle}>
              {typeLabel} {docNumber} created
            </Text>
            <Text style={styles.doneTotal}>{formatMoney(total)}</Text>
            {warnings.map((warning) => (
              <Text key={warning} style={styles.warningText}>
                {warning}
              </Text>
            ))}
            {Platform.OS !== 'web' && localPdfUri ? (
              <Pressable
                onPress={sharePdf}
                style={({ pressed }) => [styles.primaryButton, pressed && styles.buttonPressed]}>
                <Ionicons name="share-outline" size={18} color={colors.ink} />
                <Text style={styles.primaryButtonText}>Share PDF</Text>
              </Pressable>
            ) : null}
            <Pressable
              onPress={() => router.back()}
              style={({ pressed }) => [styles.secondaryButton, pressed && styles.buttonPressed]}>
              <Text style={styles.secondaryButtonText}>Done</Text>
            </Pressable>
            {error ? <Text style={styles.errorText}>{error}</Text> : null}
          </View>
        ) : (
          <>
            <Text style={styles.sectionTitle}>Line items</Text>
            <View style={styles.card}>
              <View style={styles.itemHeaderRow}>
                <Text style={[styles.itemHeaderText, styles.nameCol]}>Item</Text>
                <Text style={[styles.itemHeaderText, styles.qtyCol]}>Qty</Text>
                <Text style={[styles.itemHeaderText, styles.rateCol]}>Rate</Text>
                <View style={styles.removeCol} />
              </View>
              {items.map((row, index) => (
                <View key={row.key} style={[styles.itemRow, index > 0 && styles.rowBorderTop]}>
                  <TextInput
                    style={[styles.input, styles.nameCol]}
                    value={row.name}
                    onChangeText={(text) => updateItem(row.key, { name: text })}
                    placeholder="Description of work"
                    placeholderTextColor={colors.inkSoft}
                  />
                  <TextInput
                    style={[styles.input, styles.qtyCol]}
                    value={row.qty}
                    onChangeText={(text) => updateItem(row.key, { qty: text })}
                    placeholder="1"
                    placeholderTextColor={colors.inkSoft}
                    keyboardType="decimal-pad"
                  />
                  <TextInput
                    style={[styles.input, styles.rateCol]}
                    value={row.rate}
                    onChangeText={(text) => updateItem(row.key, { rate: text })}
                    placeholder="0.00"
                    placeholderTextColor={colors.inkSoft}
                    keyboardType="decimal-pad"
                  />
                  <Pressable
                    onPress={() => removeItem(row.key)}
                    disabled={items.length === 1}
                    style={styles.removeCol}
                    hitSlop={8}>
                    <Ionicons
                      name="close-circle"
                      size={20}
                      color={items.length === 1 ? colors.tan : colors.danger}
                    />
                  </Pressable>
                </View>
              ))}
              <Pressable
                onPress={addItem}
                style={({ pressed }) => [styles.addRow, pressed && styles.rowPressed]}>
                <Ionicons name="add-circle" size={18} color={colors.ocean} />
                <Text style={styles.addRowText}>Add line item</Text>
              </Pressable>
              {type === 'estimate' ? (
                <>
                  <Pressable
                    onPress={toggleSupplement}
                    style={({ pressed }) => [styles.addRow, pressed && styles.rowPressed]}>
                    <Ionicons
                      name={supplementOn ? 'checkbox' : 'square-outline'}
                      size={18}
                      color={colors.ocean}
                    />
                    <Text style={styles.addRowText}>
                      Supplement — racking & railing ($136 / panel)
                    </Text>
                  </Pressable>
                  {supplementOn ? (
                    <Text style={styles.supplementHint}>
                      Adds the prefilled racking & railing warranty item — set the quantity to
                      the panel count. The full warranty wording prints under the item on the
                      PDF.
                    </Text>
                  ) : null}
                </>
              ) : null}
              <View style={styles.totalRow}>
                <Text style={styles.totalLabel}>Total</Text>
                <Text style={styles.totalValue}>{formatMoney(total)}</Text>
              </View>
              <Text style={styles.taxNote}>No tax applied</Text>
            </View>

            <Text style={styles.sectionTitle}>Notes / terms</Text>
            <View style={styles.card}>
              <TextInput
                style={[styles.input, styles.notesInput]}
                value={notes}
                onChangeText={setNotes}
                placeholder="Optional notes or terms"
                placeholderTextColor={colors.inkSoft}
                multiline
              />
            </View>

            {error ? <Text style={styles.errorText}>{error}</Text> : null}
            {warnings.map((warning) => (
              <Text key={warning} style={styles.warningText}>
                {warning}
              </Text>
            ))}

            <Pressable
              onPress={create}
              disabled={phase === 'creating' || !docNumber}
              style={({ pressed }) => [
                styles.primaryButton,
                (pressed || phase === 'creating') && styles.buttonPressed,
              ]}>
              {phase === 'creating' ? (
                <ActivityIndicator color={colors.ink} />
              ) : (
                <Ionicons name="document-text" size={18} color={colors.ink} />
              )}
              <Text style={styles.primaryButtonText}>
                {phase === 'creating'
                  ? 'Creating…'
                  : Platform.OS === 'web'
                    ? 'Create & print'
                    : 'Create & preview PDF'}
              </Text>
            </Pressable>
          </>
        )}
      </ScrollView>
    </>
  );
}

const styles = StyleSheet.create({
  safe: {
    flex: 1,
    backgroundColor: colors.cream,
  },
  container: {
    padding: spacing.lg,
    paddingBottom: spacing.xl,
    gap: spacing.md,
  },
  center: {
    flex: 1,
    backgroundColor: colors.cream,
    alignItems: 'center',
    justifyContent: 'center',
    padding: spacing.xl,
    gap: spacing.sm,
  },
  blockText: {
    color: colors.inkSoft,
    fontSize: 15,
    fontWeight: '600',
    textAlign: 'center',
  },
  headerCard: {
    backgroundColor: colors.white,
    borderRadius: radii.md,
    padding: spacing.md,
    gap: 2,
    ...shadows.card,
  },
  headerType: {
    color: colors.inkSoft,
    fontSize: 12,
    fontWeight: '800',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  headerJob: {
    color: colors.ink,
    fontSize: 18,
    fontWeight: '800',
  },
  headerCustomer: {
    color: colors.inkSoft,
    fontSize: 14,
    fontWeight: '600',
  },
  headerNumber: {
    color: colors.ocean,
    fontSize: 14,
    fontWeight: '800',
    marginTop: spacing.xs,
  },
  sectionTitle: {
    color: colors.ink,
    fontSize: 18,
    fontWeight: '700',
    marginTop: spacing.sm,
  },
  card: {
    backgroundColor: colors.white,
    borderRadius: radii.md,
    padding: spacing.md,
    gap: spacing.sm,
    ...shadows.card,
  },
  itemHeaderRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
  },
  itemHeaderText: {
    color: colors.inkSoft,
    fontSize: 11,
    fontWeight: '800',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  itemRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingTop: spacing.xs,
  },
  rowBorderTop: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.tan,
  },
  nameCol: {
    flex: 1,
  },
  qtyCol: {
    width: 56,
  },
  rateCol: {
    width: 84,
  },
  removeCol: {
    width: 24,
    alignItems: 'center',
  },
  input: {
    backgroundColor: colors.cream,
    borderRadius: radii.sm,
    borderWidth: 1,
    borderColor: colors.tan,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.sm,
    color: colors.ink,
    fontSize: 14,
    fontWeight: '600',
  },
  notesInput: {
    minHeight: 72,
    textAlignVertical: 'top',
  },
  addRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    paddingVertical: spacing.xs,
  },
  addRowText: {
    color: colors.ocean,
    fontSize: 14,
    fontWeight: '700',
  },
  rowPressed: {
    opacity: 0.6,
  },
  supplementHint: {
    color: colors.inkSoft,
    fontSize: 12,
    fontWeight: '600',
    marginTop: -spacing.xs,
  },
  totalRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    backgroundColor: colors.sunLight,
    borderRadius: radii.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm + 2,
    marginTop: spacing.xs,
  },
  totalLabel: {
    color: colors.ink,
    fontSize: 14,
    fontWeight: '800',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  totalValue: {
    color: colors.ink,
    fontSize: 18,
    fontWeight: '800',
  },
  taxNote: {
    color: colors.inkSoft,
    fontSize: 11,
    fontWeight: '600',
    textAlign: 'right',
  },
  primaryButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.sm,
    backgroundColor: colors.sun,
    borderRadius: radii.pill,
    paddingVertical: spacing.md - 2,
    paddingHorizontal: spacing.lg,
    marginTop: spacing.sm,
    alignSelf: 'stretch',
    ...shadows.card,
  },
  buttonPressed: {
    opacity: 0.7,
  },
  primaryButtonText: {
    color: colors.ink,
    fontSize: 15,
    fontWeight: '800',
  },
  secondaryButton: {
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.white,
    borderWidth: 1,
    borderColor: colors.tan,
    borderRadius: radii.pill,
    paddingVertical: spacing.md - 2,
    paddingHorizontal: spacing.lg,
    marginTop: spacing.xs,
    alignSelf: 'stretch',
  },
  secondaryButtonText: {
    color: colors.ink,
    fontSize: 15,
    fontWeight: '800',
  },
  doneCard: {
    backgroundColor: colors.white,
    borderRadius: radii.md,
    padding: spacing.lg,
    alignItems: 'center',
    gap: spacing.sm,
    ...shadows.card,
  },
  doneTitle: {
    color: colors.ink,
    fontSize: 17,
    fontWeight: '800',
    textAlign: 'center',
  },
  doneTotal: {
    color: colors.ocean,
    fontSize: 22,
    fontWeight: '800',
  },
  errorText: {
    color: colors.danger,
    fontSize: 13,
    fontWeight: '600',
    textAlign: 'center',
  },
  warningText: {
    color: colors.danger,
    fontSize: 13,
    fontWeight: '600',
    textAlign: 'center',
  },
});
