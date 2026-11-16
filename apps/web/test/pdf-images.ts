import { inflateSync } from 'node:zlib';
import {
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFName,
  type PDFNumber,
  type PDFObject,
  PDFRawStream,
  PDFRef,
} from 'pdf-lib';

/**
 * Reads a label PDF back (F8, A33): every image XObject's pixels and where each page draws
 * them, and every embedded font and the text drawn with it. Used by the unit test and by the
 * end-to-end test on the file the browser downloaded.
 */

export interface PdfImage {
  ref: string;
  width: number;
  height: number;
  /** One byte per pixel, row by row, as the image stream holds it. */
  pixels: Uint8Array;
}

export interface Placement {
  page: number;
  ref: string;
  /** Points, from the page's bottom-left corner. */
  x: number;
  y: number;
  width: number;
  height: number;
}

function streamBytes(stream: PDFRawStream): Uint8Array {
  const filter = stream.dict.get(PDFName.of('Filter'));
  const flate = filter === PDFName.of('FlateDecode');
  if (filter && !flate) throw new Error(`Unexpected filter ${String(filter)}`);
  return flate ? new Uint8Array(inflateSync(stream.contents)) : stream.contents;
}

export interface PdfFont {
  ref: string;
  baseFont: string;
  /** The embedded TrueType subset (FontFile2). */
  program: Uint8Array;
  /** Glyph ID to the characters it stands for, from the font's ToUnicode map. */
  unicode: Map<number, string>;
}

export interface PdfText {
  page: number;
  font: string;
  size: number;
  x: number;
  y: number;
  glyphs: number[];
  /** The glyphs' characters, left to right as drawn. */
  text: string;
}

const num = (dict: PDFDict, key: string) => (dict.get(PDFName.of(key)) as PDFNumber).asNumber();

function readFont(doc: PDFDocument, ref: PDFRef, dict: PDFDict): PdfFont {
  const unicode = new Map<number, string>();
  const cmap = doc.context.lookup(dict.get(PDFName.of('ToUnicode'))) as PDFRawStream;
  const cmapText = new TextDecoder('latin1').decode(streamBytes(cmap));
  for (const block of cmapText.matchAll(/beginbfchar([\s\S]*?)endbfchar/g)) {
    for (const m of block[1]!.matchAll(/<([0-9a-fA-F]+)> <([0-9a-fA-F]+)>/g)) {
      const units = m[2]!.match(/.{4}/g)!.map((h) => Number.parseInt(h, 16));
      unicode.set(Number.parseInt(m[1]!, 16), String.fromCharCode(...units));
    }
  }
  const descendants = dict.lookup(PDFName.of('DescendantFonts'), PDFArray);
  const cid = descendants.lookup(0, PDFDict);
  const descriptor = cid.lookup(PDFName.of('FontDescriptor'), PDFDict);
  const program = streamBytes(descriptor.lookup(PDFName.of('FontFile2')) as PDFRawStream);
  const baseFont = (dict.get(PDFName.of('BaseFont')) as PDFName).decodeText();
  return { ref: ref.toString(), baseFont, program, unicode };
}

export async function readLabelPdf(bytes: Uint8Array) {
  const doc = await PDFDocument.load(bytes);
  const images = new Map<string, PdfImage>();
  for (const [ref, object] of doc.context.enumerateIndirectObjects()) {
    if (!(object instanceof PDFRawStream)) continue;
    if (object.dict.get(PDFName.of('Subtype')) !== PDFName.of('Image')) continue;
    const width = num(object.dict, 'Width');
    const height = num(object.dict, 'Height');
    if (object.dict.get(PDFName.of('ColorSpace')) !== PDFName.of('DeviceGray'))
      throw new Error('Label images are grey.');
    if (num(object.dict, 'BitsPerComponent') !== 8) throw new Error('Label images are 8-bit.');
    const pixels = streamBytes(object);
    if (pixels.length !== width * height) throw new Error('Image size mismatch.');
    images.set(ref.toString(), { ref: ref.toString(), width, height, pixels });
  }

  const fonts = new Map<string, PdfFont>();
  for (const [ref, object] of doc.context.enumerateIndirectObjects()) {
    if (!(object instanceof PDFDict) || object instanceof PDFRawStream) continue;
    if (object.get(PDFName.of('Subtype')) !== PDFName.of('Type0')) continue;
    fonts.set(ref.toString(), readFont(doc, ref, object));
  }

  const placements: Placement[] = [];
  const texts: PdfText[] = [];
  doc.getPages().forEach((page, index) => {
    const resources = page.node.Resources();
    const xobjects = resources?.lookupMaybe(PDFName.of('XObject'), PDFDict);
    const refs = new Map<string, string>();
    for (const [name, value] of xobjects?.entries() ?? []) {
      if (value instanceof PDFRef) refs.set(name.asString(), value.toString());
    }
    const fontNames = new Map<string, string>();
    for (const [name, value] of resources?.lookupMaybe(PDFName.of('Font'), PDFDict)?.entries() ??
      []) {
      if (value instanceof PDFRef) fontNames.set(name.asString(), value.toString());
    }
    const contents = page.node.Contents();
    const streams: PDFObject[] =
      contents instanceof PDFArray
        ? contents.asArray().map((r) => doc.context.lookup(r)!)
        : contents
          ? [contents]
          : [];
    const text = streams
      .map((s) => new TextDecoder('latin1').decode(streamBytes(s as PDFRawStream)))
      .join('\n');
    // pdf-lib writes each image as: q, a 0 0 d e f cm, /Name Do, Q.
    for (const m of text.matchAll(/([-\d.]+) 0 0 ([-\d.]+) ([-\d.]+) ([-\d.]+) cm\s+(\/\S+) Do/g)) {
      const ref = refs.get(m[5]!);
      if (!ref) throw new Error(`Unknown image ${m[5]}`);
      placements.push({
        page: index,
        ref,
        width: Number(m[1]),
        height: Number(m[2]),
        x: Number(m[3]),
        y: Number(m[4]),
      });
    }
    // pdf-lib writes each run of text as: BT, colour, /Name size Tf, 1 0 0 1 x y Tm, <ids> Tj, ET.
    for (const m of text.matchAll(
      /(\/\S+) ([\d.]+) Tf\s+1 0 0 1 ([-\d.]+) ([-\d.]+) Tm\s+<([0-9A-Fa-f]*)> Tj/g,
    )) {
      const ref = fontNames.get(m[1]!);
      const font = ref ? fonts.get(ref) : undefined;
      if (!font) throw new Error(`Unknown font ${m[1]}`);
      const glyphs = (m[5]!.match(/.{4}/g) ?? []).map((h) => Number.parseInt(h, 16));
      texts.push({
        page: index,
        font: font.ref,
        size: Number(m[2]),
        x: Number(m[3]),
        y: Number(m[4]),
        glyphs,
        text: glyphs.map((g) => font.unicode.get(g) ?? '\uFFFD').join(''),
      });
    }
  });
  return {
    pages: doc.getPageCount(),
    images: [...images.values()],
    placements,
    fonts: [...fonts.values()],
    texts,
  };
}
