import Ionicons from '@expo/vector-icons/Ionicons';
import * as Print from 'expo-print';
import { Stack, router, useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Platform, StyleSheet, TextInput, View } from 'react-native';

import { Field } from '@/components/forms/Field';
import {
  AnimatedPressable,
  AppText,
  Button,
  Card,
  Chip,
  EmptyState,
  Screen,
  SectionHeader,
  SkeletonList,
} from '@/components/ui';
import { colors, radii, spacing } from '@/constants/theme';
import { fetchJob, getDocumentUrl } from '@/lib/data';
import { todayISO } from '@/lib/dates';
import {
  attachRenderedPdf,
  buildDocumentHtml,
  computeTotals,
  duplicateDocument,
  fetchFinanceEntry,
  fetchJobFinanceEntries,
  insertDocumentEntry,
  newClientToken,
  nextDocumentNumber,
  renderDocumentPdf,
  reviseDocument,
  revisionStoragePath,
  uploadGeneratedPdf,
  type CustomerSnapshot,
  type DocumentMeta,
  type DocumentTotals,
  type DocumentType,
  type FinanceEntry,
  type LineItem,
} from '@/lib/documents';
import * as haptics from '@/lib/haptics';
import { type Job } from '@/lib/types';
import { shareLocalPdf, viewDocument } from '@/lib/pdf';
import { getRole, type RoleInfo } from '@/lib/role';
import { isValidISODate } from '@/lib/time';

interface ItemRow {
  key: number;
  name: string;
  qty: string;
  rate: string;
  /** Per-line note printed under the item on the PDF. */
  description: string;
  /** Is the note input revealed? Rows that already have a note start open. */
  noteOpen: boolean;
  /** Row added by the Supplement checkbox — seeds the warranty description. */
  supplement?: boolean;
}

/**
 * Prefilled "Supplement" estimate line item (racking & railing warranty).
 * Devon adjusts the quantity per estimate; the price is per panel. The
 * wording is a starting point, not a constant: since 2026-08-22 it lands in
 * the row's own note field and can be edited like any other line's.
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

/** Everything reviseDocument() needs, kept so Retry save can re-fire it. */
interface PendingRevise {
  token: string;
  revision: number;
  lineItems: LineItem[];
  totals: DocumentTotals;
  meta: DocumentMeta;
  documentPath: string | null;
  /** null = no archive object exists; the history row keeps the living path. */
  archivePath: string | null;
  pdfState: 'current' | 'stale';
  fileSize: number | null;
}

function snapshotFromJob(job: Job | null): CustomerSnapshot {
  return {
    name: job?.customer?.name ?? 'Customer',
    address: job?.customer?.address ?? null,
    email: job?.customer?.email ?? null,
    phone: job?.customer?.phone ?? null,
  };
}

function sameSnapshot(a: CustomerSnapshot, b: CustomerSnapshot): boolean {
  const norm = (v: string | null | undefined) => (v ?? '').trim();
  return (
    norm(a.name) === norm(b.name) &&
    norm(a.address) === norm(b.address) &&
    norm(a.email) === norm(b.email) &&
    norm(a.phone) === norm(b.phone)
  );
}

/**
 * Create OR revise an estimate / invoice.
 *
 * `entryId` switches the screen into REVISE mode: the row's line items (with
 * their notes), terms, date, adjustments and frozen customer snapshot all load
 * back, the document NUMBER is kept, and Save appends a revision through
 * revise_document() instead of inserting a second row. Before 2026-08-22 the
 * only way to correct a document was to delete the finance row and retype it,
 * which is why an edited estimate routinely pointed at a PDF showing the old
 * number.
 *
 * `fromEntryId` copies an existing document into a new one of `type` first
 * (estimate → invoice) and then revises that copy.
 */
export default function DocumentBuilderScreen() {
  const params = useLocalSearchParams<{
    jobId?: string;
    type?: string;
    entryId?: string;
    fromEntryId?: string;
  }>();
  const paramJobId = typeof params.jobId === 'string' ? params.jobId : '';
  const paramEntryId = typeof params.entryId === 'string' ? params.entryId : '';
  const fromEntryId = typeof params.fromEntryId === 'string' ? params.fromEntryId : '';
  const paramType: DocumentType = params.type === 'estimate' ? 'estimate' : 'invoice';

  const [role, setRole] = useState<RoleInfo | null | 'loading'>('loading');
  const [job, setJob] = useState<Job | null>(null);
  const [entry, setEntry] = useState<FinanceEntry | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [docNumber, setDocNumber] = useState<string | null>(null);
  const [estimateCount, setEstimateCount] = useState(0);

  const [items, setItems] = useState<ItemRow[]>([
    { key: 1, name: '', qty: '1', rate: '', description: '', noteOpen: false },
  ]);
  const [nextKey, setNextKey] = useState(2);
  const [notes, setNotes] = useState(DEFAULT_NOTES[paramType]);
  const [occurredOn, setOccurredOn] = useState(todayISO());
  const [discount, setDiscount] = useState('');
  const [taxRate, setTaxRate] = useState('');
  const [validUntil, setValidUntil] = useState('');
  const [snapshot, setSnapshot] = useState<CustomerSnapshot | null>(null);
  const [adjustmentsOpen, setAdjustmentsOpen] = useState(false);
  const [billToOpen, setBillToOpen] = useState(false);

  const [phase, setPhase] = useState<'editing' | 'saving' | 'done'>('editing');
  const [busyLabel, setBusyLabel] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [localPdfUri, setLocalPdfUri] = useState<string | null>(null);

  // Revision save bookkeeping.
  const [savedRevision, setSavedRevision] = useState<number | null>(null);
  const [savedArchivePath, setSavedArchivePath] = useState<string | null>(null);
  const [savedStale, setSavedStale] = useState(false);
  const [pendingRevise, setPendingRevise] = useState<PendingRevise | null>(null);
  const [committed, setCommitted] = useState<PendingRevise | null>(null);
  const tokenRef = useRef<string | null>(null);

  /**
   * Set when revise_document() refuses because somebody else revised this
   * document first (SQLSTATE 40001). Deliberately NOT `error`: every other
   * failure offers Retry save, and a retry is the one thing that cannot work
   * here — the same token would carry the same stale expected revision and be
   * refused identically. The only way forward is Reload.
   */
  const [conflict, setConflict] = useState<string | null>(null);
  /** Bumped by Reload to re-run the load effect against the same document. */
  const [reloadKey, setReloadKey] = useState(0);
  /**
   * The entry this screen actually settled on. Matters only for the
   * `fromEntryId` deep link: `paramEntryId` is empty there, and a reload that
   * fell back to the params would duplicate the source document a SECOND time
   * rather than re-reading the copy.
   */
  const loadedEntryIdRef = useRef<string | null>(null);

  const entryId = entry?.id ?? paramEntryId;
  const mode: 'create' | 'revise' = entryId ? 'revise' : 'create';
  const type: DocumentType =
    entry && (entry.type === 'estimate' || entry.type === 'invoice') ? entry.type : paramType;
  const typeLabel = type === 'invoice' ? 'Invoice' : 'Estimate';
  const jobId = entry?.job_id ?? paramJobId;
  const currentRevision = entry?.revision ?? 1;
  const pdfStale = entry?.document_meta?.pdf_state === 'stale';

  useEffect(() => {
    let cancelled = false;
    getRole().then((info) => {
      if (!cancelled) setRole(info);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  /** Seed every editor field from a loaded document row. */
  const hydrateFromEntry = useCallback((row: FinanceEntry) => {
    const meta = row.document_meta ?? {};
    const loaded = (row.line_items ?? []).map((item, index) => ({
      key: index + 1,
      name: item.name,
      qty: String(item.qty ?? ''),
      rate: String(item.rate ?? ''),
      description: item.description ?? '',
      noteOpen: Boolean(item.description),
      supplement: item.name === SUPPLEMENT_NAME,
    }));
    setItems(
      loaded.length > 0
        ? loaded
        : [{ key: 1, name: '', qty: '1', rate: '', description: '', noteOpen: false }],
    );
    setNextKey(loaded.length + 1);
    setNotes(row.notes ?? '');
    setOccurredOn(row.occurred_on ?? todayISO());
    setDocNumber(row.document_number);
    setDiscount(meta.discount != null && meta.discount > 0 ? String(meta.discount) : '');
    setTaxRate(meta.tax != null && meta.tax > 0 ? String(meta.tax) : '');
    setValidUntil(meta.valid_until ?? '');
    setSnapshot(meta.customer_snapshot ?? null);
  }, []);

  useEffect(() => {
    let cancelled = false;

    const run = async () => {
      setLoading(true);
      setLoadError(null);

      // "Duplicate as invoice" can also arrive as a deep link: copy first,
      // then revise the copy. JobInvoices normally does the copy itself and
      // pushes entryId straight away.
      //
      // `loadedEntryIdRef` first on a RELOAD: the copy has already been made
      // and re-running duplicateDocument() would make a third document.
      let targetEntryId = paramEntryId || loadedEntryIdRef.current || '';
      if (!targetEntryId && fromEntryId) {
        const copied = await duplicateDocument({ sourceEntryId: fromEntryId, asType: paramType });
        if (cancelled) return;
        if (!copied.ok) {
          setLoadError(copied.message);
          setLoading(false);
          return;
        }
        targetEntryId = copied.entryId;
      }

      if (targetEntryId) {
        const row = await fetchFinanceEntry(targetEntryId);
        if (cancelled) return;
        if (!row) {
          setLoadError('That document could not be loaded.');
          setLoading(false);
          return;
        }
        loadedEntryIdRef.current = row.id;
        setEntry(row);
        hydrateFromEntry(row);
        if (row.job_id) {
          const [loadedJob, finance] = await Promise.all([
            fetchJob(row.job_id),
            fetchJobFinanceEntries(row.job_id),
          ]);
          if (cancelled) return;
          setJob(loadedJob);
          setEstimateCount(
            finance.status === 'ok'
              ? finance.entries.filter((e) => e.type === 'estimate').length
              : 0,
          );
          if (!row.document_meta?.customer_snapshot) {
            setSnapshot(snapshotFromJob(loadedJob));
          }
        }
        setLoading(false);
        return;
      }

      if (!paramJobId) {
        setLoading(false);
        return;
      }
      const loadedJob = await fetchJob(paramJobId);
      if (cancelled) return;
      setJob(loadedJob);
      setSnapshot(snapshotFromJob(loadedJob));
      if (loadedJob?.job_number) {
        const num = await nextDocumentNumber(loadedJob.id, loadedJob.job_number, paramType);
        if (!cancelled) setDocNumber(num);
      } else if (loadedJob) {
        setDocNumber(
          `${loadedJob.id.slice(0, 8)}-${paramType === 'invoice' ? 'Invoice' : 'Estimate'}`,
        );
      }
      if (!cancelled) setLoading(false);
    };

    run();
    return () => {
      cancelled = true;
    };
    // `reloadKey` is the whole point of the Reload button: it re-runs this
    // effect, which re-reads the entry (and therefore its CURRENT revision) so
    // the next Save is numbered against what the server actually holds.
  }, [paramJobId, paramType, paramEntryId, fromEntryId, hydrateFromEntry, reloadKey]);

  /**
   * Throw away this screen's state and re-read the document.
   *
   * The client token goes with it: it was minted for a revision number that no
   * longer applies, and revise_document() would match it against the LAST
   * token stored on the row — which, after somebody else's revision, is
   * theirs. Everything the editor shows is replaced by the server's copy, so
   * any edits made here have to be made again on top of the newer revision.
   * That is the honest outcome of a conflict: the alternative is silently
   * reapplying them over work we never saw.
   */
  const reload = useCallback(() => {
    tokenRef.current = null;
    setConflict(null);
    setError(null);
    setWarnings([]);
    setPendingRevise(null);
    setCommitted(null);
    setSavedRevision(null);
    setSavedArchivePath(null);
    setSavedStale(false);
    setPhase('editing');
    setReloadKey((key) => key + 1);
  }, []);

  const lineItems = useMemo<LineItem[]>(
    () =>
      items
        .filter((row) => row.name.trim().length > 0)
        .map((row) => ({
          name: row.name.trim(),
          ...(row.description.trim() ? { description: row.description.trim() } : {}),
          qty: parseNum(row.qty),
          rate: parseNum(row.rate),
        })),
    [items],
  );

  const totals = useMemo(
    () => computeTotals(lineItems, parseNum(discount), parseNum(taxRate)),
    [lineItems, discount, taxRate],
  );

  const liveSnapshot = snapshotFromJob(job);
  const snapshotChanged =
    snapshot != null && job?.customer != null && !sameSnapshot(snapshot, liveSnapshot);

  const updateItem = (key: number, patch: Partial<ItemRow>) => {
    setItems((prev) => prev.map((row) => (row.key === key ? { ...row, ...patch } : row)));
  };

  const addItem = () => {
    setItems((prev) => [
      ...prev,
      { key: nextKey, name: '', qty: '1', rate: '', description: '', noteOpen: false },
    ]);
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
        description: SUPPLEMENT_DESCRIPTION,
        noteOpen: false,
        supplement: true,
      },
    ]);
    setNextKey((k) => k + 1);
  };

  /** Shared validation for Preview, Create and Save revision. */
  const validate = (): boolean => {
    if (lineItems.length === 0) {
      setError('Add at least one line item with a name.');
      return false;
    }
    if (lineItems.some((item) => item.qty <= 0)) {
      setError('Every line item needs a quantity greater than zero.');
      return false;
    }
    const date = occurredOn.trim();
    if (date !== '' && !isValidISODate(date)) {
      setError('Enter the date as YYYY-MM-DD (e.g. 2026-08-22).');
      return false;
    }
    if (validUntil.trim() !== '' && !isValidISODate(validUntil.trim())) {
      setError('Enter "valid until" as YYYY-MM-DD, or leave it blank.');
      return false;
    }
    setError(null);
    return true;
  };

  const buildHtml = (revision: number): string =>
    buildDocumentHtml({
      type,
      documentNumber: docNumber ?? '',
      dateISO: occurredOn.trim() || todayISO(),
      customerName: snapshot?.name ?? liveSnapshot.name,
      customerAddress: snapshot?.address ?? liveSnapshot.address,
      customerEmail: snapshot?.email ?? liveSnapshot.email,
      customerPhone: snapshot?.phone ?? liveSnapshot.phone,
      jobNumber: job?.job_number,
      jobName: job?.name,
      jobAddress: job?.address,
      lineItems,
      notes: notes.trim() || null,
      revision,
      validUntil: validUntil.trim() || null,
      discount: parseNum(discount) || null,
      tax: parseNum(taxRate) || null,
    });

  const buildMeta = (): DocumentMeta => ({
    customer_snapshot: snapshot ?? liveSnapshot,
    valid_until: validUntil.trim() || null,
    totals,
    tax: parseNum(taxRate) || null,
    discount: parseNum(discount) || null,
  });

  const openPrintWindow = (html: string) => {
    const printable = html.replace(
      '</body>',
      '<script>setTimeout(function(){window.print();},400);</script></body>',
    );
    const win = typeof window !== 'undefined' ? window.open('', '_blank') : null;
    if (win) {
      win.document.write(printable);
      win.document.close();
      return true;
    }
    return false;
  };

  /** Render the document as it stands WITHOUT writing anything anywhere. */
  const preview = async () => {
    if (!validate() || !docNumber) return;
    setWarnings([]);
    setBusyLabel('Preparing preview…');
    try {
      const html = buildHtml(mode === 'revise' ? currentRevision + 1 : 1);
      if (Platform.OS === 'web') {
        if (!openPrintWindow(html)) {
          setError('Could not open the print window (popup blocked?).');
        }
        return;
      }
      const { uri } = await Print.printToFileAsync({ html });
      const shared = await shareLocalPdf(uri, `${docNumber}-preview.pdf`);
      if (!shared) setError('Sharing is not available on this device.');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not build the preview.');
    } finally {
      setBusyLabel(null);
    }
  };

  // -------------------------------------------------------------------------
  // Creation (unchanged behaviour — one new row, one PDF)
  // -------------------------------------------------------------------------
  const create = async () => {
    if (!job || !docNumber || !validate()) return;
    setWarnings([]);

    const customerName = snapshot?.name ?? liveSnapshot.name;
    const date = occurredOn.trim() || todayISO();
    const meta = buildMeta();
    const html = buildHtml(1);

    setPhase('saving');
    try {
      if (Platform.OS === 'web') {
        if (!openPrintWindow(html)) {
          setWarnings((prev) => [
            ...prev,
            'Could not open the print window (popup blocked?). The entry was still recorded.',
          ]);
        }
        const insert = await insertDocumentEntry({
          type,
          amount: totals.total,
          counterparty: customerName,
          description: `${typeLabel} ${docNumber}`,
          occurredOn: date,
          jobId: job.id,
          customerId: job.customer_id,
          documentNumber: docNumber,
          documentPath: null,
          lineItems,
          notes: notes.trim() || null,
          // No file is stored on web, so the row is honest about it: the
          // Retry/⚠ path in revise mode is what fixes it later.
          documentMeta: { ...meta, pdf_state: 'stale' },
        });
        if (!insert.ok) {
          setError(`The ${type} entry could not be saved: ${insert.message}`);
          setPhase('editing');
          return;
        }
        haptics.success();
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
        amount: totals.total,
        counterparty: customerName,
        description: `${typeLabel} ${docNumber}`,
        occurredOn: date,
        jobId: job.id,
        customerId: job.customer_id,
        documentNumber: docNumber,
        documentPath: upload.ok ? upload.storagePath : null,
        lineItems,
        notes: notes.trim() || null,
        documentMeta: { ...meta, pdf_state: upload.ok ? 'current' : 'stale' },
      });
      if (!insert.ok) {
        setWarnings((prev) => [
          ...prev,
          `The ${type} entry could not be recorded (${insert.message}). The PDF is still available to share below.`,
        ]);
      }
      haptics.success();
      setPhase('done');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not create the PDF. Please try again.');
      setPhase('editing');
    }
  };

  // -------------------------------------------------------------------------
  // Revision: render → save. The save is what counts; a failed render only
  // marks the PDF stale, it never loses the numbers.
  // -------------------------------------------------------------------------
  const commitRevise = async (args: PendingRevise) => {
    const result = await reviseDocument({
      entryId,
      lineItems: args.lineItems,
      amount: args.totals.total,
      notes: notes.trim() || null,
      occurredOn: occurredOn.trim() || null,
      documentMeta: args.meta,
      documentPath: args.documentPath,
      archivePath: args.archivePath,
      pdfState: args.pdfState,
      fileSize: args.fileSize,
      clientToken: args.token,
      // The revision this screen RENDERED and archived under. If the server
      // is about to write a different number, somebody else got here first
      // and our archive object name already belongs to their PDF.
      expectedRevision: args.revision,
    });
    if (!result.ok) {
      if (result.code === 'conflict') {
        // No Retry save: the same token carries the same stale expectation and
        // would be refused identically. Reload is the only way forward.
        setPendingRevise(null);
        setError(null);
        setConflict(result.message);
        setPhase('editing');
        return;
      }
      setPendingRevise(args);
      setError(result.message);
      setPhase('editing');
      return;
    }
    setPendingRevise(null);
    setConflict(null);
    // The token is spent. Keeping it would make the NEXT Save on this screen
    // an idempotent no-op — revise_document() would hand back the revision
    // that already happened and silently drop the new edits.
    tokenRef.current = null;
    setCommitted(args);
    setEntry((prev) => (prev ? { ...prev, revision: result.revision } : prev));
    setSavedRevision(result.revision);
    setSavedArchivePath(args.archivePath);
    setSavedStale(args.pdfState === 'stale');
    haptics.success();
    setPhase('done');
  };

  const saveRevision = async () => {
    if (!docNumber || !jobId || !validate()) return;
    setWarnings([]);
    setPhase('saving');

    // One token per Save press, reused by every retry below: revise_document()
    // returns the revision that already happened rather than burning a second
    // one, so a double tap (or a retry after a half-failed save) is harmless.
    const token = tokenRef.current ?? newClientToken();
    tokenRef.current = token;

    const revision = currentRevision + 1;
    const meta = buildMeta();
    const archivePath = revisionStoragePath(jobId, docNumber, revision);

    try {
      const render = await renderDocumentPdf({
        html: buildHtml(revision),
        entryId,
        jobId,
        documentNumber: docNumber,
        revision,
      });
      if (render.ok) {
        if (render.localUri) setLocalPdfUri(render.localUri);
        if (render.warning) setWarnings((prev) => [...prev, render.warning as string]);
      } else if (render.code === 'conflict') {
        // The pre-flight revision check refused the upload: somebody else
        // already saved this revision number. Nothing was written, so skip
        // the RPC (it would raise 40001 anyway) and go straight to Reload.
        tokenRef.current = null;
        setConflict(render.message);
        setPhase('editing');
        return;
      } else {
        setWarnings((prev) => [...prev, render.message]);
      }
      await commitRevise({
        token,
        revision,
        lineItems,
        totals,
        meta: { ...meta, pdf_state: render.ok ? 'current' : 'stale' },
        // A failed render leaves the LIVING path alone (null = "don't touch"),
        // while the history row still names the archive object the retry will
        // write, so nothing has to be rewritten when it lands.
        documentPath: render.ok ? render.storagePath : null,
        archivePath: render.ok ? render.archivePath : archivePath,
        pdfState: render.ok ? 'current' : 'stale',
        fileSize: render.ok ? render.sizeBytes : null,
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save the revision.');
      setPhase('editing');
    }
  };

  /** The RPC failed after a good render — re-fire it with the same token. */
  const retrySave = async () => {
    if (!pendingRevise) return;
    setPhase('saving');
    await commitRevise(pendingRevise);
  };

  /** The save landed but the PDF didn't. Re-render THIS revision, not a new one. */
  const retryPdf = async () => {
    if (!docNumber || !jobId || savedRevision == null) return;
    setError(null);
    setBusyLabel('Rendering PDF…');
    try {
      const render = await renderDocumentPdf({
        html: buildHtml(savedRevision),
        entryId,
        jobId,
        documentNumber: docNumber,
        revision: savedRevision,
      });
      if (!render.ok) {
        setError(render.message);
        return;
      }
      if (render.localUri) setLocalPdfUri(render.localUri);
      const attached = await attachRenderedPdf({
        entryId,
        jobId,
        documentNumber: docNumber,
        documentType: type,
        // Re-send the meta the RPC stored, token included: this write replaces
        // document_meta wholesale, and dropping last_client_token would quietly
        // disarm the double-tap guard for that token.
        documentMeta: committed
          ? { ...committed.meta, last_client_token: committed.token }
          : buildMeta(),
        storagePath: render.storagePath,
        sizeBytes: render.sizeBytes,
      });
      if (!attached.ok) {
        setError(attached.message);
        return;
      }
      haptics.success();
      setSavedStale(false);
      setWarnings([]);
    } finally {
      setBusyLabel(null);
    }
  };

  const viewSavedRevision = async () => {
    const path = savedArchivePath ?? entry?.document_path;
    if (!path) return;
    setError(null);
    const url = await getDocumentUrl(path, savedRevision);
    if (!url || !(await viewDocument(url))) {
      setError('Could not open that PDF. It may still be generating.');
    }
  };

  const sharePdf = async () => {
    if (!localPdfUri) return;
    // Copy under the real document name first — the printer's temp file has
    // a random UUID name that would otherwise show up in the share sheet.
    const shared = await shareLocalPdf(localPdfUri, `${docNumber ?? 'document'}.pdf`);
    if (!shared) setError('Sharing is not available on this device.');
  };

  const screenTitle =
    mode === 'revise'
      ? `Revise ${typeLabel} ${docNumber ?? ''} (rev ${currentRevision})`.trim()
      : `New ${type}`;

  if (role === 'loading' || loading) {
    return (
      <>
        <Stack.Screen options={{ title: screenTitle }} />
        <Screen edges={[]}>
          <SkeletonList count={4} height={120} />
        </Screen>
      </>
    );
  }

  if (!role || !role.isAdmin) {
    return (
      <>
        <Stack.Screen options={{ title: screenTitle }} />
        <Screen edges={[]}>
          <Card>
            <EmptyState
              icon="lock-closed"
              title="Admins only"
              body="Estimates and invoices are only available to admins. Please sign in with an admin account."
            />
          </Card>
        </Screen>
      </>
    );
  }

  if (loadError) {
    return (
      <>
        <Stack.Screen options={{ title: screenTitle }} />
        <Screen edges={[]}>
          <Card>
            <EmptyState icon="alert-circle" title={loadError} />
          </Card>
        </Screen>
      </>
    );
  }

  if (!job) {
    return (
      <>
        <Stack.Screen options={{ title: screenTitle }} />
        <Screen edges={[]}>
          <Card>
            <EmptyState
              icon="help-circle"
              title="Job not found."
              body="It may have been deleted, or the link is out of date."
            />
          </Card>
        </Screen>
      </>
    );
  }

  const saving = phase === 'saving';

  return (
    <>
      <Stack.Screen options={{ title: screenTitle }} />
      <Screen edges={[]}>
        <Card style={styles.headerCard}>
          <AppText variant="section" color={colors.textMuted}>
            {mode === 'revise' ? `Revise ${typeLabel.toLowerCase()}` : typeLabel}
          </AppText>
          <AppText variant="heading">
            {job.job_number ? `${job.job_number} · ` : ''}
            {job.name}
          </AppText>
          {snapshot?.name ? (
            <AppText variant="body" color={colors.textMuted}>
              {snapshot.name}
            </AppText>
          ) : null}
          <View style={styles.headerNumberRow}>
            <AppText variant="bodyStrong" color={colors.accentPrimary}>
              {docNumber ?? '…'}
            </AppText>
            {mode === 'revise' && currentRevision > 1 ? (
              <Chip label={`rev ${currentRevision}`} tone="olive" />
            ) : null}
            {pdfStale && phase !== 'done' ? (
              <Chip
                label={entry?.document_path ? 'PDF out of date' : 'No PDF stored yet'}
                icon="warning"
                tone="sun"
              />
            ) : null}
          </View>
        </Card>

        {phase === 'done' ? (
          <Card style={styles.doneCard}>
            <Ionicons
              name={savedStale ? 'warning' : 'checkmark-circle'}
              size={30}
              color={savedStale ? colors.danger : colors.accentPrimary}
            />
            <AppText variant="heading" align="center">
              {mode === 'revise' && savedRevision != null
                ? `${typeLabel} ${docNumber} saved as revision ${savedRevision}`
                : `${typeLabel} ${docNumber} created`}
            </AppText>
            <AppText variant="numeric" color={colors.accentPrimary}>
              {formatMoney(totals.total)}
            </AppText>
            {savedStale ? (
              <AppText variant="caption" color={colors.danger} align="center">
                The numbers are saved, but the stored PDF still shows the previous revision.
              </AppText>
            ) : null}
            {warnings.map((warning) => (
              <AppText key={warning} variant="caption" color={colors.danger} align="center">
                {warning}
              </AppText>
            ))}
            {savedStale ? (
              <Button
                label="Retry PDF"
                icon="refresh"
                onPress={() => void retryPdf()}
                loading={busyLabel !== null}
                disabled={busyLabel !== null}
                fullWidth
                style={styles.stackedButton}
              />
            ) : null}
            {mode === 'revise' && savedRevision != null && !savedStale ? (
              <Button
                label={`View rev ${savedRevision}`}
                variant="secondary"
                onPress={() => void viewSavedRevision()}
                fullWidth
                style={styles.stackedButton}
              />
            ) : null}
            {Platform.OS !== 'web' && localPdfUri ? (
              <Button
                label="Share PDF"
                icon="share-outline"
                onPress={sharePdf}
                fullWidth
                style={styles.stackedButton}
              />
            ) : null}
            <Button
              label="Done"
              variant="secondary"
              onPress={() => router.back()}
              fullWidth
              style={styles.stackedButton}
            />
            {error ? (
              <AppText variant="caption" color={colors.danger} align="center">
                {error}
              </AppText>
            ) : null}
          </Card>
        ) : (
          <>
            <SectionHeader title="Line items" icon="list" />
            <Card>
              <View style={styles.itemHeaderRow}>
                <AppText variant="section" color={colors.textMuted} style={styles.nameCol}>
                  Item
                </AppText>
                <AppText variant="section" color={colors.textMuted} style={styles.qtyCol}>
                  Qty
                </AppText>
                <AppText variant="section" color={colors.textMuted} style={styles.rateCol}>
                  Rate
                </AppText>
                <View style={styles.removeCol} />
              </View>

              {items.map((row, index) => (
                <View key={row.key} style={index > 0 ? styles.rowBorderTop : undefined}>
                  <View style={styles.itemRow}>
                    <TextInput
                      style={[styles.input, styles.nameCol]}
                      value={row.name}
                      onChangeText={(text) => updateItem(row.key, { name: text })}
                      placeholder="Description of work"
                      placeholderTextColor={colors.textMuted}
                    />
                    <TextInput
                      style={[styles.input, styles.qtyCol]}
                      value={row.qty}
                      onChangeText={(text) => updateItem(row.key, { qty: text })}
                      placeholder="1"
                      placeholderTextColor={colors.textMuted}
                      keyboardType="decimal-pad"
                    />
                    <TextInput
                      style={[styles.input, styles.rateCol]}
                      value={row.rate}
                      onChangeText={(text) => updateItem(row.key, { rate: text })}
                      placeholder="0.00"
                      placeholderTextColor={colors.textMuted}
                      keyboardType="decimal-pad"
                    />
                    <AnimatedPressable
                      onPress={() => removeItem(row.key)}
                      disabled={items.length === 1}
                      haptic="tapLight"
                      accessibilityRole="button"
                      accessibilityLabel="Remove line item"
                      style={styles.removeCol}
                      hitSlop={8}>
                      <Ionicons
                        name="close-circle"
                        size={20}
                        color={items.length === 1 ? colors.border : colors.danger}
                      />
                    </AnimatedPressable>
                  </View>

                  <AnimatedPressable
                    onPress={() => updateItem(row.key, { noteOpen: !row.noteOpen })}
                    haptic="tapLight"
                    hitSlop={6}
                    accessibilityRole="button"
                    accessibilityState={{ expanded: row.noteOpen }}
                    accessibilityLabel="Line item note"
                    style={styles.noteToggle}>
                    <AppText variant="caption" color={colors.accentLink}>
                      {row.noteOpen ? '− note' : row.description ? '＋ note (1)' : '＋ note'}
                    </AppText>
                  </AnimatedPressable>

                  {row.noteOpen ? (
                    <TextInput
                      style={[styles.input, styles.noteInput]}
                      value={row.description}
                      onChangeText={(text) => updateItem(row.key, { description: text })}
                      placeholder="Prints in small type under the item on the PDF"
                      placeholderTextColor={colors.textMuted}
                      multiline
                    />
                  ) : null}
                </View>
              ))}

              <AnimatedPressable
                onPress={addItem}
                haptic="tapLight"
                accessibilityRole="button"
                accessibilityLabel="Add line item"
                style={styles.addRow}>
                <Ionicons name="add-circle" size={18} color={colors.accentPrimary} />
                <AppText variant="bodyStrong" color={colors.accentPrimary}>
                  Add line item
                </AppText>
              </AnimatedPressable>

              {type === 'estimate' ? (
                <>
                  <AnimatedPressable
                    onPress={toggleSupplement}
                    haptic="tapLight"
                    accessibilityRole="checkbox"
                    accessibilityState={{ checked: supplementOn }}
                    accessibilityLabel="Supplement — racking and railing"
                    style={styles.addRow}>
                    <Ionicons
                      name={supplementOn ? 'checkbox' : 'square-outline'}
                      size={18}
                      color={colors.accentPrimary}
                    />
                    <AppText variant="bodyStrong" color={colors.accentPrimary}>
                      Supplement — racking &amp; railing ($136 / panel)
                    </AppText>
                  </AnimatedPressable>
                  {supplementOn ? (
                    <AppText variant="caption" color={colors.textMuted}>
                      Adds the prefilled racking &amp; railing warranty item — set the quantity to
                      the panel count. Its wording lives in the row&apos;s own note and can be
                      edited.
                    </AppText>
                  ) : null}
                </>
              ) : null}

              <View style={styles.totalRow}>
                <AppText variant="section" color={colors.ink}>
                  Total
                </AppText>
                <AppText variant="bodyStrong" color={colors.ink} style={styles.totalValue}>
                  {formatMoney(totals.total)}
                </AppText>
              </View>
              {totals.tax > 0 ? (
                <AppText variant="caption" color={colors.textMuted} align="right">
                  Includes {formatMoney(totals.tax)} sales tax
                </AppText>
              ) : (
                <AppText variant="caption" color={colors.textMuted} align="right">
                  No tax applied
                </AppText>
              )}
            </Card>

            <AnimatedPressable
              onPress={() => setAdjustmentsOpen((open) => !open)}
              haptic="tapLight"
              scaleTo={0.995}
              accessibilityRole="button"
              accessibilityState={{ expanded: adjustmentsOpen }}
              accessibilityLabel="Adjustments"
              style={styles.collapseToggle}>
              <Ionicons
                name={adjustmentsOpen ? 'chevron-down' : 'chevron-forward'}
                size={16}
                color={colors.accentPrimary}
              />
              <AppText variant="section" color={colors.accentPrimary}>
                Adjustments
                {totals.discount > 0 || totals.tax > 0
                  ? ` · ${[
                      totals.discount > 0 ? `−${formatMoney(totals.discount)}` : null,
                      totals.tax > 0 ? `tax ${formatMoney(totals.tax)}` : null,
                    ]
                      .filter(Boolean)
                      .join(' · ')}`
                  : ''}
              </AppText>
            </AnimatedPressable>

            {adjustmentsOpen ? (
              <Card>
                <Field
                  label="Discount ($ off the subtotal)"
                  value={discount}
                  onChangeText={setDiscount}
                  placeholder="0.00"
                  keyboardType="decimal-pad"
                />
                <Field
                  label="Sales tax rate (%)"
                  value={taxRate}
                  onChangeText={setTaxRate}
                  placeholder="0"
                  keyboardType="decimal-pad"
                />
                {type === 'estimate' ? (
                  <Field
                    label="Valid until (YYYY-MM-DD)"
                    value={validUntil}
                    onChangeText={setValidUntil}
                    placeholder="Optional"
                    autoCapitalize="none"
                    autoCorrect={false}
                  />
                ) : null}
                <View style={styles.totalsBreakdown}>
                  {(
                    [
                      ['Subtotal', totals.subtotal],
                      ['Discount', -totals.discount],
                      ['Tax', totals.tax],
                      ['Total', totals.total],
                    ] as [string, number][]
                  ).map(([label, value], i) => (
                    <View key={label} style={styles.breakdownRow}>
                      <AppText
                        variant={i === 3 ? 'bodyStrong' : 'caption'}
                        color={i === 3 ? colors.textPrimary : colors.textMuted}>
                        {label}
                      </AppText>
                      <AppText
                        variant={i === 3 ? 'bodyStrong' : 'caption'}
                        numberOfLines={1}
                        style={styles.breakdownValue}>
                        {value < 0 ? `−${formatMoney(Math.abs(value))}` : formatMoney(value)}
                      </AppText>
                    </View>
                  ))}
                </View>
              </Card>
            ) : null}

            <AnimatedPressable
              onPress={() => setBillToOpen((open) => !open)}
              haptic="tapLight"
              scaleTo={0.995}
              accessibilityRole="button"
              accessibilityState={{ expanded: billToOpen }}
              accessibilityLabel="Bill to"
              style={styles.collapseToggle}>
              <Ionicons
                name={billToOpen ? 'chevron-down' : 'chevron-forward'}
                size={16}
                color={colors.accentPrimary}
              />
              <AppText variant="section" color={colors.accentPrimary}>
                Bill to{snapshot?.name ? ` · ${snapshot.name}` : ''}
              </AppText>
              {snapshotChanged ? <View style={styles.changedDot} /> : null}
            </AnimatedPressable>

            {billToOpen ? (
              <Card>
                {(
                  [
                    ['Name', snapshot?.name ?? '—'],
                    ['Address', snapshot?.address ?? '—'],
                    ['Email', snapshot?.email ?? '—'],
                    ['Phone', snapshot?.phone ?? '—'],
                  ] as [string, string][]
                ).map(([label, value]) => (
                  <View key={label} style={styles.breakdownRow}>
                    <AppText variant="caption" color={colors.textMuted}>
                      {label}
                    </AppText>
                    <AppText variant="caption" numberOfLines={2} style={styles.breakdownValue}>
                      {value}
                    </AppText>
                  </View>
                ))}
                {snapshotChanged ? (
                  <>
                    <AppText variant="caption" color={colors.textMuted} style={styles.hint}>
                      Customer record has changed — use current details?
                    </AppText>
                    <Button
                      label="Use current details"
                      variant="secondary"
                      size="sm"
                      onPress={() => setSnapshot(liveSnapshot)}
                    />
                  </>
                ) : null}
              </Card>
            ) : null}

            <SectionHeader title="Date" icon="calendar" />
            <Card style={styles.stackCard}>
              {/* No field label: the section header above already says Date. */}
              <TextInput
                style={styles.input}
                value={occurredOn}
                onChangeText={setOccurredOn}
                placeholder="YYYY-MM-DD"
                placeholderTextColor={colors.textMuted}
                autoCapitalize="none"
                autoCorrect={false}
              />
              {type === 'estimate' && estimateCount > 1 ? (
                <AppText variant="caption" color={colors.textMuted}>
                  This job has {estimateCount} estimates. Only the newest one by date counts toward
                  the Estimates total — changing this date can change which one that is.
                </AppText>
              ) : null}
            </Card>

            <SectionHeader title="Notes / terms" icon="document-text" />
            <Card>
              <TextInput
                style={[styles.input, styles.notesInput]}
                value={notes}
                onChangeText={setNotes}
                placeholder="Optional notes or terms"
                placeholderTextColor={colors.textMuted}
                multiline
              />
            </Card>

            {conflict ? (
              <Card style={styles.conflictCard}>
                <View style={styles.conflictHeader}>
                  <Ionicons name="git-branch" size={20} color={colors.danger} />
                  <AppText variant="bodyStrong" color={colors.danger}>
                    {conflict}
                  </AppText>
                </View>
                <AppText variant="caption" color={colors.textMuted}>
                  Someone else saved a revision of {docNumber} while this was open, so revision{' '}
                  {currentRevision + 1} is already taken. Reloading fetches their version — the
                  changes on this screen are not saved and will need making again.
                </AppText>
                <Button
                  label="Reload"
                  icon="refresh"
                  onPress={reload}
                  disabled={saving}
                  fullWidth
                  style={styles.stackedButton}
                />
              </Card>
            ) : null}

            {error ? (
              <AppText variant="caption" color={colors.danger} align="center">
                {error}
              </AppText>
            ) : null}
            {warnings.map((warning) => (
              <AppText key={warning} variant="caption" color={colors.danger} align="center">
                {warning}
              </AppText>
            ))}

            {/* Never both: a conflict clears pendingRevise, because the same
                token would be refused for the same reason. */}
            {pendingRevise ? (
              <Button
                label="Retry save"
                icon="refresh"
                onPress={() => void retrySave()}
                disabled={saving}
                fullWidth
              />
            ) : null}

            <Button
              label={busyLabel ?? (Platform.OS === 'web' ? 'Preview & print' : 'Preview PDF')}
              variant="secondary"
              onPress={() => void preview()}
              disabled={saving || busyLabel !== null || !docNumber}
              fullWidth
            />

            <Button
              label={
                saving
                  ? 'Saving…'
                  : mode === 'revise'
                    ? `Save revision ${currentRevision + 1}`
                    : Platform.OS === 'web'
                      ? 'Create & print'
                      : 'Create & preview PDF'
              }
              icon="document-text"
              onPress={() => void (mode === 'revise' ? saveRevision() : create())}
              loading={saving}
              // Blocked while a conflict stands: this screen's revision number
              // is known-stale, so pressing Save would render a PDF, upload it
              // over someone else's archive object, and be refused for exactly
              // the same reason. Reload first.
              disabled={saving || !docNumber || conflict !== null}
              size="lg"
              fullWidth
            />
          </>
        )}
      </Screen>
    </>
  );
}

const styles = StyleSheet.create({
  headerCard: {
    gap: 2,
  },
  headerNumberRow: {
    flexDirection: 'row',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: spacing.xs,
    marginTop: spacing.xs,
  },
  doneCard: {
    alignItems: 'center',
    gap: spacing.sm,
    padding: spacing.lg,
  },
  conflictCard: {
    gap: spacing.xs,
    borderWidth: 1,
    borderColor: colors.danger,
  },
  conflictHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
  },
  stackedButton: {
    marginTop: spacing.xs,
  },
  itemHeaderRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
  },
  itemRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingTop: spacing.xs,
  },
  rowBorderTop: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
    marginTop: spacing.xs,
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
    backgroundColor: colors.surfaceSunk,
    borderRadius: radii.sm,
    borderWidth: 1,
    borderColor: colors.border,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.sm,
    color: colors.textPrimary,
    fontSize: 14,
  },
  noteInput: {
    minHeight: 60,
    textAlignVertical: 'top',
    marginBottom: spacing.xs,
  },
  notesInput: {
    minHeight: 72,
    textAlignVertical: 'top',
  },
  stackCard: {
    gap: spacing.sm,
  },
  noteToggle: {
    alignSelf: 'flex-start',
    paddingVertical: 2,
  },
  addRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    paddingVertical: spacing.xs,
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
  totalValue: {
    fontSize: 18,
    lineHeight: 23,
    fontVariant: ['tabular-nums'],
  },
  collapseToggle: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    paddingVertical: spacing.xs,
  },
  changedDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: colors.accentAction,
  },
  totalsBreakdown: {
    backgroundColor: colors.surfaceSunk,
    borderRadius: radii.sm,
    padding: spacing.sm,
    gap: spacing.xs,
  },
  breakdownRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.sm,
  },
  breakdownValue: {
    flexShrink: 1,
    textAlign: 'right',
    fontVariant: ['tabular-nums'],
  },
  hint: {
    marginTop: spacing.xs,
    marginBottom: spacing.xs,
  },
});
