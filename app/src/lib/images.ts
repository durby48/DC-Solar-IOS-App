/**
 * Image compression for every upload the app makes.
 *
 * WHY THIS EXISTS. Until now the four upload paths (customer avatar, Employee
 * of the Month, job photo, receipt) sent the picker's file straight to
 * Supabase Storage, and each of them carried a comment saying "there is no
 * image-processing library in the bundle". There is one now —
 * `expo-image-manipulator` — and a modern phone camera produces 4 000 px,
 * 4–8 MB JPEGs. A crew member photographing eight receipts on a driveway LTE
 * connection was uploading roughly fifty megabytes to render four thumbnails.
 * At 1920 px / q0.75 the same eight are about three.
 *
 * SDK 57'S OBJECT API, NOT `manipulateAsync`. `ImageManipulator.manipulate()`
 * opens a context, `renderAsync()` resolves to an `ImageRef` THAT KNOWS ITS
 * OWN SIZE, and only then is a resize scheduled. Rendering first is the whole
 * trick: `resize({width: 1920})` on a 900 px photo makes the file BIGGER and
 * the picture no better, and `expo-image-picker` does not reliably report
 * dimensions. `lib/cards.ts::compressArt` uses the same shape — this is the
 * generic version of it.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * IT NEVER THROWS, AND THAT IS THE CONTRACT
 * ─────────────────────────────────────────────────────────────────────────
 * Every failure — an unsupported platform, a HEIC the decoder dislikes, an
 * out-of-memory on an old iPad, the module simply not being in this build —
 * returns the ORIGINAL uri. A bigger upload is a slower upload; a thrown
 * error is a photo the crew member loses. Callers can treat the result as a
 * drop-in replacement for the uri they were about to send and never need a
 * try/catch of their own.
 *
 * Always JPEG. PNG screenshots of a receipt compress worse than the same
 * picture as JPEG, WebP is only encoded by Android (see `cards.ts`), and
 * every consumer here is a photograph rather than line art. Transparency is
 * not a thing any of these four uploads has.
 */

import { ImageManipulator, SaveFormat } from 'expo-image-manipulator';

/** The default long edge. 1920 fills a Retina phone screen with room to spare. */
export const DEFAULT_MAX_WIDTH = 1920;
/** JPEG quality. 0.75 is where artefacts stop being visible on a photograph. */
export const DEFAULT_QUALITY = 0.75;

export interface CompressedImage {
  /** The compressed file, or the original uri when compression was skipped. */
  uri: string;
  /** Pixel size of the result, or null when it could not be determined. */
  width: number | null;
  height: number | null;
  /** False when the original was handed back untouched. */
  compressed: boolean;
}

export interface CompressOptions {
  /** Shrink only if the image is WIDER than this. Default 1920. */
  maxWidth?: number;
  /** JPEG quality, 0–1. Default 0.75. */
  quality?: number;
}

/**
 * Is the manipulator actually usable in this bundle?
 *
 * `expo-image-manipulator` ships a web implementation (canvas-based), so this
 * is true in the browser too — but a build that dropped the native module, or
 * a future SDK that renames the export, must degrade rather than crash on the
 * first receipt somebody photographs.
 */
function available(): boolean {
  try {
    return typeof (ImageManipulator as { manipulate?: unknown } | undefined)?.manipulate === 'function';
  } catch {
    return false;
  }
}

/**
 * Shrink a picked image toward `maxWidth` and re-encode it as JPEG.
 *
 * Returns the original uri unchanged on any failure — see the module
 * docstring. The height is scaled to preserve the aspect ratio; passing only
 * a width to `resize()` is what makes the manipulator work the other side out.
 */
export async function compressForUpload(
  uri: string,
  options: CompressOptions = {},
): Promise<CompressedImage> {
  const maxWidth = Math.max(1, Math.round(options.maxWidth ?? DEFAULT_MAX_WIDTH));
  const quality = Math.min(1, Math.max(0.1, options.quality ?? DEFAULT_QUALITY));
  const original: CompressedImage = { uri, width: null, height: null, compressed: false };

  if (!uri || !available()) return original;

  try {
    const context = ImageManipulator.manipulate(uri);
    let rendered = await context.renderAsync();

    // Only shrink. Upscaling a small photo costs bytes and buys nothing.
    if (rendered.width > maxWidth) {
      context.resize({ width: maxWidth });
      rendered = await context.renderAsync();
    }

    const saved = await rendered.saveAsync({ compress: quality, format: SaveFormat.JPEG });
    if (!saved?.uri) return original;
    return {
      uri: saved.uri,
      width: typeof saved.width === 'number' ? saved.width : null,
      height: typeof saved.height === 'number' ? saved.height : null,
      compressed: true,
    };
  } catch {
    // A device that can't run the manipulator uploads the original file:
    // worse for the data plan, completely fine for the photo.
    return original;
  }
}
