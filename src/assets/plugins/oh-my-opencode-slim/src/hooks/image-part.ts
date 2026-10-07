/**
 * Single seam for every host image-part shape.
 *
 * opencode's media part has changed shape three times — v1 `file`/`image`
 * parts with data URLs, the flat v2 `{mediaType, data}`, and v2.0.14+
 * `{media: Media.Asset}` class instances (the dev branch returns to the flat
 * shape). JSON-persisted replay can also hand over a serialized Asset with no
 * top-level `mediaType` and `bytes` sources encoded as base64 strings. Every
 * fact about recognizing and extracting images from those shapes lives here;
 * callers only ever see the normalized view below.
 *
 * `bytes` means the image can be materialized now; `remote` means it is an
 * image with no local payload (https URLs, Asset `url`/`ref` sources,
 * malformed carriers) — such parts are never stripped, and the host's own
 * capability replacement is the backstop. `null` means not an image.
 *
 * Payloads the host could not classify (absent or `application/octet-stream`
 * mime) get one last chance: their image signature is sniffed, so a
 * clipboard image the host failed to type still reaches the observer
 * pipeline. Specifically declared non-image types are never second-guessed.
 */

export interface ImageBytesView {
  readonly view: 'bytes';
  readonly bytes: Buffer;
  readonly ext: string;
  readonly filename?: string;
}

export interface ImageRemoteView {
  readonly view: 'remote';
}

export type ImagePartView = ImageBytesView | ImageRemoteView;

const IMAGE_FILE_EXTENSION_RE =
  /\.(png|jpg|jpeg|gif|bmp|webp|svg|ico|tiff?|heic|heif|avif)$/i;

export const MIME_EXT_BY_TYPE: Record<string, string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'image/svg+xml': '.svg',
  'image/bmp': '.bmp',
  'image/tiff': '.tiff',
  'image/heic': '.heic',
  'image/heif': '.heic',
  'image/avif': '.avif',
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function partFilename(part: Record<string, unknown>): string | undefined {
  return typeof part.filename === 'string'
    ? part.filename
    : typeof part.name === 'string'
      ? part.name
      : undefined;
}

function hasImageFileExtension(filename: string | undefined): boolean {
  return Boolean(filename && IMAGE_FILE_EXTENSION_RE.test(filename));
}

function isImageMime(mime: string | undefined): boolean {
  return Boolean(mime?.startsWith('image/'));
}

/** Mime values that mean "the host could not classify this payload". */
function isUnclassifiedMime(mime: string | undefined): boolean {
  return mime === undefined || mime === 'application/octet-stream';
}

const PNG_SIGNATURE = Buffer.from('89504e470d0a1a0a', 'hex');
const GIF8_SIGNATURE = Buffer.from('GIF8', 'latin1');
const RIFF_SIGNATURE = Buffer.from('RIFF', 'latin1');
const WEBP_SIGNATURE = Buffer.from('WEBP', 'latin1');
const TIFF_LE_SIGNATURE = Buffer.from('II*\x00', 'latin1');
const TIFF_BE_SIGNATURE = Buffer.from('MM\x00*', 'latin1');
const FTYP_SIGNATURE = Buffer.from('ftyp', 'latin1');

/**
 * Image signatures for payloads the host could not classify (absent or
 * `application/octet-stream` mime). Never used to second-guess a specific
 * declared type.
 */
function sniffImageMime(bytes: Buffer | undefined): string | undefined {
  if (!bytes || bytes.length < 4) return undefined;
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(PNG_SIGNATURE)) {
    return 'image/png';
  }
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'image/jpeg';
  }
  if (bytes.subarray(0, 4).equals(GIF8_SIGNATURE)) return 'image/gif';
  if (
    bytes.length >= 12 &&
    bytes.subarray(0, 4).equals(RIFF_SIGNATURE) &&
    bytes.subarray(8, 12).equals(WEBP_SIGNATURE)
  ) {
    return 'image/webp';
  }
  if (bytes[0] === 0x42 && bytes[1] === 0x4d) return 'image/bmp';
  if (
    bytes.subarray(0, 4).equals(TIFF_LE_SIGNATURE) ||
    bytes.subarray(0, 4).equals(TIFF_BE_SIGNATURE)
  ) {
    return 'image/tiff';
  }
  if (bytes.length >= 12 && bytes.subarray(4, 8).equals(FTYP_SIGNATURE)) {
    const brand = bytes.subarray(8, 12).toString('latin1');
    if (brand.startsWith('avi')) return 'image/avif';
    if (
      brand.startsWith('hei') ||
      brand.startsWith('mif') ||
      brand.startsWith('msf')
    ) {
      return 'image/heic';
    }
  }
  return undefined;
}

/**
 * Last-chance classification for parts with no usable evidence: sniff an
 * unclassified inline payload. Falls back to null when nothing rescues it.
 */
function rescueUnclassified(
  mime: string | undefined,
  filename: string | undefined,
  bytes: Buffer | null,
): ImagePartView | null {
  const sniffed =
    isUnclassifiedMime(mime) && bytes && bytes.length > 0
      ? sniffImageMime(bytes)
      : undefined;
  if (!sniffed || !bytes) return null;
  return { view: 'bytes', bytes, ext: extOf(sniffed, filename), filename };
}

/** Base64 string or raw Uint8Array payload (flat dev shape) to bytes. */
function decodePayload(data: unknown): Buffer | null {
  if (data instanceof Uint8Array) return Buffer.from(data);
  if (typeof data === 'string' && data.length > 0) {
    // Buffer.from leniently decodes invalid base64 instead of throwing;
    // host-produced parts are well-formed, and the fail-open contract
    // (never throw, never block) takes precedence here.
    return Buffer.from(data, 'base64');
  }
  return null;
}

function decodeDataUrl(url: string): { mime: string; data: Buffer } | null {
  const match = url.match(/^data:([^;]+);base64,(.+)$/);
  if (!match) return null;
  return { mime: match[1], data: Buffer.from(match[2], 'base64') };
}

/** Extension: mime mapping first, then the filename extension, then .png. */
function extOf(mime: string | undefined, filename: string | undefined): string {
  if (mime) {
    const ext = MIME_EXT_BY_TYPE[mime];
    if (ext) return ext;
  }
  if (filename) {
    const dot = filename.lastIndexOf('.');
    if (dot > 0 && dot < filename.length - 1) return filename.slice(dot);
  }
  return '.png';
}

/**
 * MediaAsset as seen by the hook: a live `Media.Asset` instance or its
 * JSON-serialized form (`source` only — no top-level mediaType, `bytes`
 * sources as base64 strings). Dispatch on structure, never on the type tag
 * alone: the host's shape has drifted exactly there.
 */
function assetView(
  media: Record<string, unknown>,
  filename: string | undefined,
): ImagePartView | null {
  const source = isRecord(media.source) ? media.source : undefined;
  const mime =
    (typeof media.mediaType === 'string' ? media.mediaType : undefined) ??
    (typeof source?.mediaType === 'string' ? source.mediaType : undefined);
  const inline = source?.type === 'base64' || source?.type === 'bytes';
  const bytes = inline ? decodePayload(source.data) : null;

  if (!isImageMime(mime) && !hasImageFileExtension(filename)) {
    // Clipboard images can arrive declared application/octet-stream; sniff
    // the signature before giving up.
    return rescueUnclassified(mime, filename, bytes);
  }

  // url/ref sources (and anything unrecognized) carry no local payload.
  if (!inline) return { view: 'remote' };
  if (!bytes || bytes.length === 0) return { view: 'remote' };
  return { view: 'bytes', bytes, ext: extOf(mime, filename), filename };
}

export function asImagePart(part: unknown): ImagePartView | null {
  if (!isRecord(part) || typeof part.type !== 'string') return null;
  const filename = partFilename(part);

  if (part.type === 'image' || part.type === 'file') {
    const url = typeof part.url === 'string' ? part.url : undefined;
    const decoded = url ? decodeDataUrl(url) : null;
    // v1 payloads travel as data URLs, but keep accepting a base64 `data`
    // field (the pre-refactor hook did) so nothing materializable is left
    // inline.
    const bytes = decoded?.data ?? decodePayload(part.data);
    const mime = typeof part.mime === 'string' ? part.mime : decoded?.mime;

    // v1 `image` parts are images by host construction; `file` parts need
    // mime or filename-extension evidence — or, for an unclassified payload,
    // a sniffed image signature.
    if (
      part.type === 'file' &&
      !isImageMime(mime) &&
      !hasImageFileExtension(filename)
    ) {
      return rescueUnclassified(mime, filename, bytes);
    }
    // Same contract as the media branches: a bytes view is never empty.
    if (!bytes || bytes.length === 0) return { view: 'remote' };
    return {
      view: 'bytes',
      bytes,
      ext: extOf(
        mime ?? (isUnclassifiedMime(mime) ? sniffImageMime(bytes) : undefined),
        filename,
      ),
      filename,
    };
  }

  if (part.type === 'media') {
    // v2 flat `{mediaType, data}` …
    if (!isRecord(part.media)) {
      const mime =
        typeof part.mediaType === 'string' ? part.mediaType : undefined;
      const bytes = decodePayload(part.data);
      if (!isImageMime(mime) && !hasImageFileExtension(filename)) {
        return rescueUnclassified(mime, filename, bytes);
      }
      if (!bytes || bytes.length === 0) return { view: 'remote' };
      return { view: 'bytes', bytes, ext: extOf(mime, filename), filename };
    }
    // … and v2.0.14+ `{media: Media.Asset}`.
    return assetView(part.media, filename);
  }

  return null;
}
