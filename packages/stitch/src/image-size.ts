/**
 * Width and height from a PNG, JPEG, or WebP header, as the browser draws it:
 * a JPEG turned by its EXIF orientation reports the turned size.
 */
export function readImageSize(bytes: Uint8Array): {
  width: number;
  height: number;
} {
  const format = formatOf(bytes);
  if (format === null)
    throw new Error('A still has to be a png, jpeg, or webp');
  const size =
    format === 'png'
      ? pngSize(bytes)
      : format === 'jpeg'
        ? jpegSize(bytes)
        : webpSize(bytes);
  if (!size) throw new Error(`the ${format} header is unreadable`);
  return size;
}

function formatOf(bytes: Uint8Array): 'png' | 'jpeg' | 'webp' | null {
  const sig = [137, 80, 78, 71, 13, 10, 26, 10];
  if (bytes.length >= 8 && sig.every((byte, i) => bytes[i] === byte))
    return 'png';
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return 'jpeg';
  if (ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 12) === 'WEBP')
    return 'webp';
  return null;
}

function pngSize(bytes: Uint8Array): { width: number; height: number } | null {
  if (bytes.length < 24) return null;
  if (ascii(bytes, 12, 16) !== 'IHDR') return null;
  return { width: u32be(bytes, 16), height: u32be(bytes, 20) };
}

function jpegSize(bytes: Uint8Array): { width: number; height: number } | null {
  let offset = 2;
  let turned = false;
  while (offset + 8 < bytes.length) {
    if (bytes[offset] !== 0xff) return null;
    const marker = bytes[offset + 1] ?? 0;
    if (marker === 0xd8 || marker === 0xd9) {
      offset += 2;
      continue;
    }
    // Standalone markers (TEM, RST) carry no length.
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      offset += 2;
      continue;
    }
    const length = u16be(bytes, offset + 2);
    if (length < 2) return null;
    const isStartOfFrame =
      marker >= 0xc0 &&
      marker <= 0xcf &&
      marker !== 0xc4 &&
      marker !== 0xc8 &&
      marker !== 0xcc;
    if (
      marker === 0xe1 &&
      ascii(bytes, offset + 4, offset + 10) === 'Exif\0\0'
    ) {
      turned = exifTurnsSideways(bytes, offset + 10, offset + 2 + length);
    }
    if (isStartOfFrame && offset + 8 < bytes.length) {
      const height = u16be(bytes, offset + 5);
      const width = u16be(bytes, offset + 7);
      return turned ? { width: height, height: width } : { width, height };
    }
    offset += 2 + length;
  }
  return null;
}

/** EXIF orientations 5–8 turn the picture a quarter, swapping its sides. */
function exifTurnsSideways(
  bytes: Uint8Array,
  tiff: number,
  end: number
): boolean {
  if (end > bytes.length || tiff + 8 > end) return false;
  const order = ascii(bytes, tiff, tiff + 2);
  if (order !== 'II' && order !== 'MM') return false;
  const view = data(bytes);
  const little = order === 'II';
  const ifd = tiff + view.getUint32(tiff + 4, little);
  if (ifd + 2 > end) return false;
  const count = view.getUint16(ifd, little);
  for (let i = 0; i < count; i++) {
    const entry = ifd + 2 + i * 12;
    if (entry + 12 > end) return false;
    if (view.getUint16(entry, little) === 0x0112) {
      const orientation = view.getUint16(entry + 8, little);
      return orientation >= 5 && orientation <= 8;
    }
  }
  return false;
}

function webpSize(bytes: Uint8Array): { width: number; height: number } | null {
  const chunk = ascii(bytes, 12, 16);
  if (chunk === 'VP8X' && bytes.length >= 30) {
    return { width: 1 + u24le(bytes, 24), height: 1 + u24le(bytes, 27) };
  }
  if (chunk === 'VP8 ' && bytes.length >= 30) {
    const start = 20 + 3;
    if (
      bytes[start] !== 0x9d ||
      bytes[start + 1] !== 0x01 ||
      bytes[start + 2] !== 0x2a
    ) {
      return null;
    }
    return {
      width: u16le(bytes, start + 3) & 0x3fff,
      height: u16le(bytes, start + 5) & 0x3fff,
    };
  }
  if (chunk === 'VP8L' && bytes.length >= 25 && bytes[20] === 0x2f) {
    const bits = u32le(bytes, 21);
    return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
  }
  return null;
}

function data(bytes: Uint8Array): DataView {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

function ascii(bytes: Uint8Array, start: number, end: number): string {
  let text = '';
  for (let i = start; i < end; i++) text += String.fromCharCode(bytes[i] ?? 0);
  return text;
}

function u16be(bytes: Uint8Array, offset: number): number {
  return data(bytes).getUint16(offset);
}

function u16le(bytes: Uint8Array, offset: number): number {
  return data(bytes).getUint16(offset, true);
}

function u24le(bytes: Uint8Array, offset: number): number {
  const view = data(bytes);
  return view.getUint8(offset) + view.getUint16(offset + 1, true) * 256;
}

function u32be(bytes: Uint8Array, offset: number): number {
  return data(bytes).getUint32(offset);
}

function u32le(bytes: Uint8Array, offset: number): number {
  return data(bytes).getUint32(offset, true);
}
