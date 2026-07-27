/**
 * View & share stored documents (PDFs, photos) from signed Supabase URLs.
 *
 * Viewing stays inside the app: an in-app browser sheet (SFSafariViewController
 * on iOS) renders PDFs without bouncing the user out to Safari. Sharing
 * downloads the file to cache first, then opens the iOS share sheet so it can
 * go out through iMessage, Mail, AirDrop, etc. as a real file attachment.
 * Both degrade gracefully: web falls back to a new tab, failures return false
 * so callers can show a friendly message.
 */

import { File, Paths } from 'expo-file-system';
import * as Sharing from 'expo-sharing';
import * as WebBrowser from 'expo-web-browser';
import { Linking, Platform } from 'react-native';

/** Open a signed document URL in the in-app browser sheet. */
export async function viewDocument(url: string): Promise<boolean> {
  try {
    if (Platform.OS === 'web') {
      await Linking.openURL(url);
      return true;
    }
    await WebBrowser.openBrowserAsync(url);
    return true;
  } catch {
    return false;
  }
}

/** Keep the extension, strip anything the filesystem might dislike. */
function safeFileName(fileName: string): string {
  const cleaned = fileName.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
  return cleaned || 'document.pdf';
}

/**
 * Share a freshly generated local PDF (e.g. Print.printToFileAsync output,
 * whose temp file has a random UUID name) under its proper document name —
 * the file is copied into cache as `fileName` first so the share sheet and
 * the receiving app both see "DC-26012-Estimate.pdf", not gibberish.
 */
export async function shareLocalPdf(localUri: string, fileName: string): Promise<boolean> {
  try {
    if (!(await Sharing.isAvailableAsync())) return false;
    let uri = localUri;
    try {
      const destination = new File(Paths.cache, safeFileName(fileName));
      if (destination.exists) destination.delete();
      new File(localUri).copy(destination);
      uri = destination.uri;
    } catch {
      // Copy failed — share the temp file anyway (wrong name beats no share).
    }
    await Sharing.shareAsync(uri, {
      mimeType: 'application/pdf',
      UTI: 'com.adobe.pdf',
      dialogTitle: fileName,
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Download a signed document URL to cache and open the share sheet
 * (iMessage, Mail, AirDrop…). On web, just opens the URL in a new tab.
 */
export async function shareDocument(url: string, fileName: string): Promise<boolean> {
  try {
    if (Platform.OS === 'web') {
      await Linking.openURL(url);
      return true;
    }
    if (!(await Sharing.isAvailableAsync())) return false;
    const destination = new File(Paths.cache, safeFileName(fileName));
    const file = await File.downloadFileAsync(url, destination, { idempotent: true });
    const isPdf = /\.pdf$/i.test(file.name);
    await Sharing.shareAsync(file.uri, {
      mimeType: isPdf ? 'application/pdf' : undefined,
      UTI: isPdf ? 'com.adobe.pdf' : undefined,
    });
    return true;
  } catch {
    return false;
  }
}
