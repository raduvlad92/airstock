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
 * Reads a label PDF back (F8, A33): every image XObject's pixels, and where each page draws
 * them. Used by the unit test and by the end-to-end test on the file the browser downloaded.
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

const num = (dict: PDFDict, key: string) => (dict.get(PDFName.of(key)) as PDFNumber).asNumber();

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

  const placements: Placement[] = [];
  doc.getPages().forEach((page, index) => {
    const resources = page.node.Resources();
    const xobjects = resources?.lookupMaybe(PDFName.of('XObject'), PDFDict);
    const refs = new Map<string, string>();
    for (const [name, value] of xobjects?.entries() ?? []) {
      if (value instanceof PDFRef) refs.set(name.asString(), value.toString());
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
  });
  return { pages: doc.getPageCount(), images: [...images.values()], placements };
}
