import type { Symbology } from '@airstock/core/barcodes';
import { code128, ean8, ean13, qrcode, upca } from 'bwip-js/generic';

/**
 * Barcode images for labels (D9, ADR 0019). bwip-js encodes the symbol and calls a drawing
 * context; this one fills a bitmap instead of a canvas, so the same code runs in the browser and
 * in Node tests, and the PDF carries exactly the pixels a test decodes.
 */

export interface BarcodeBitmap {
  /** Pixels per row, quiet zones included. */
  width: number;
  height: number;
  /** One byte per pixel: 0 dark, 255 light, row by row. */
  pixels: Uint8Array;
  /** Linear symbols are one band of bars, drawn stretched to the bar height. */
  linear: boolean;
  /** Width in modules (narrowest bars), quiet zones included, for sizing on the label. */
  modules: number;
}

/** Pixels per module in the image, so a module never straddles a pixel. */
export const PIXELS_PER_MODULE = 4;
/** Quiet zones in modules: GS1 asks for at least 11 left of an EAN-13, ISO 18004 for 4 round a QR. */
const QUIET_LINEAR = 11;
const QUIET_MATRIX = 4;

type Encoder = typeof code128;

/** Codes stored as "other" print as Code 128 when they fit it, else as a QR code. */
function encoderFor(symbology: Symbology, code: string): { encode: Encoder; linear: boolean } {
  switch (symbology) {
    case 'ean13':
      return { encode: ean13, linear: true };
    case 'ean8':
      return { encode: ean8, linear: true };
    case 'upca':
      return { encode: upca, linear: true };
    case 'code128':
      return { encode: code128, linear: true };
    case 'qr':
      return { encode: qrcode, linear: false };
    default:
      return /^[\x20-\x7e]{1,40}$/.test(code)
        ? { encode: code128, linear: true }
        : { encode: qrcode, linear: false };
  }
}

interface Raster {
  width: number;
  height: number;
  dark: Uint8Array;
  /** bwip-js pixels per module. */
  scale: number;
}

/** A bwip-js drawing context that rasterizes bars (lines) and modules (polygons, even-odd). */
function rasterizer() {
  let scaleX = 1;
  let raster: Raster | null = null;
  let paths: Array<Array<[number, number]>> = [];
  const target = () => {
    if (!raster) throw new Error('bwip-js drew before init.');
    return raster;
  };
  const fillRect = (x0: number, y0: number, x1: number, y1: number) => {
    const r = target();
    for (let y = Math.max(0, y0); y < Math.min(r.height, y1); y++)
      for (let x = Math.max(0, x0); x < Math.min(r.width, x1); x++) r.dark[y * r.width + x] = 1;
  };
  return {
    setopts() {},
    scale(sx: number) {
      scaleX = sx;
      return null;
    },
    measure(str: string, _font: string, fwidth: number, fheight: number) {
      return { width: str.length * fwidth, ascent: fheight, descent: 0 };
    },
    init(width: number, height: number) {
      const w = Math.ceil(width);
      const h = Math.ceil(height);
      raster = { width: w, height: h, dark: new Uint8Array(w * h), scale: scaleX };
    },
    // Bars: an unconnected stroke centred on x. bwip-js keeps odd widths on whole pixels by
    // shifting them half a pixel, as its own SVG drawing does.
    line(x0: number, y0: number, x1: number, y1: number, lw: number) {
      const w = Math.round(lw) || 1;
      if (x0 === x1) {
        const shift = w % 2 === 0 ? w / 2 : scaleX % 2 === 1 ? (w + 1) / 2 : (w - 1) / 2;
        const left = Math.round(x0) - shift;
        fillRect(left, Math.min(y0, y1), left + w, Math.max(y0, y1) + 1);
      } else {
        const shift = w % 2 === 0 ? w / 2 : (w + 1) / 2;
        const top = Math.round(y0) - shift;
        fillRect(Math.min(x0, x1), top, Math.max(x0, x1) + 1, top + w);
      }
    },
    polygon(points: Array<[number, number]>) {
      paths.push(points);
    },
    hexagon() {
      throw new Error('This symbology is not supported on labels.');
    },
    ellipse() {
      throw new Error('This symbology is not supported on labels.');
    },
    fill() {
      const r = target();
      for (let y = 0; y < r.height; y++) {
        const cy = y + 0.5;
        const crossings: number[] = [];
        for (const path of paths) {
          for (let i = 0; i < path.length; i++) {
            const [ax, ay] = path[i]!;
            const [bx, by] = path[(i + 1) % path.length]!;
            if (ay <= cy !== by <= cy) crossings.push(ax + ((cy - ay) / (by - ay)) * (bx - ax));
          }
        }
        crossings.sort((a, b) => a - b);
        for (let i = 0; i + 1 < crossings.length; i += 2) {
          fillRect(Math.round(crossings[i]!), y, Math.round(crossings[i + 1]!), y + 1);
        }
      }
      paths = [];
    },
    text() {},
    end() {
      return target();
    },
  };
}

/** Renders a barcode to a bitmap with its quiet zones. Throws if the code cannot be encoded. */
export function barcodeBitmap(symbology: Symbology, code: string): BarcodeBitmap {
  const { encode, linear } = encoderFor(symbology, code);
  const raster = encode(
    { bcid: '', text: code, scale: 1, includetext: false },
    // biome-ignore lint/suspicious/noExplicitAny: bwip-js types the drawing by its return value
    rasterizer() as any,
  ) as unknown as Raster;
  const quiet = linear ? QUIET_LINEAR : QUIET_MATRIX;
  const modules = Math.round(raster.width / raster.scale);
  const factor = PIXELS_PER_MODULE / raster.scale;
  const width = (modules + 2 * quiet) * PIXELS_PER_MODULE;
  if (linear) {
    // Bars run the full height without human-readable text; one band is the whole symbol.
    const row = Math.floor(raster.height / 2);
    const height = 2;
    const pixels = new Uint8Array(width * height).fill(255);
    for (let x = 0; x < raster.width; x++) {
      if (!raster.dark[row * raster.width + x]) continue;
      for (let px = 0; px < factor; px++) {
        const col = (quiet * raster.scale + x) * factor + px;
        for (let y = 0; y < height; y++) pixels[y * width + col] = 0;
      }
    }
    return { width, height, pixels, linear, modules: modules + 2 * quiet };
  }
  const rows = Math.round(raster.height / raster.scale);
  const height = (rows + 2 * quiet) * PIXELS_PER_MODULE;
  const pixels = new Uint8Array(width * height).fill(255);
  const offset = quiet * PIXELS_PER_MODULE;
  for (let y = 0; y < raster.height; y++) {
    for (let x = 0; x < raster.width; x++) {
      if (!raster.dark[y * raster.width + x]) continue;
      for (let dy = 0; dy < factor; dy++)
        for (let dx = 0; dx < factor; dx++)
          pixels[(offset + y * factor + dy) * width + offset + x * factor + dx] = 0;
    }
  }
  return { width, height, pixels, linear, modules: modules + 2 * quiet };
}
