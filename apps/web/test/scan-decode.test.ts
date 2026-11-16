import { locationCode } from '@airstock/core/barcodes';
import { describe, expect, it } from 'vitest';
import { barcodeBitmap } from '../src/labels/barcode.ts';
import { ZXING_READ_OPTIONS } from '../src/scan/formats.ts';
import { ScanThrottle } from '../src/scan/throttle.ts';
import { WedgeBuffer } from '../src/scan/wedge.ts';
import { decodeFrame } from './zxing.ts';

// D13: the codes the phone scanner meets, printed by the label renderer and seen the way a
// camera frame shows them: on a 1280 × 720 frame (the size the scanner hands zxing), smaller
// than full width, slightly tilted, low contrast as in dim light, and with sensor noise. The
// decoder is the vendored zxing-wasm build the phone loads, with the scanner's own options.

const FRAME_W = 1280;
const FRAME_H = 720;

interface FrameOptions {
  /** Width of the symbol on the frame, as a share of the frame width. */
  share: number;
  /** Tilt in degrees. */
  tilt?: number;
  /** Dark and light grey levels (dim light narrows the range). */
  dark?: number;
  light?: number;
  noise?: number;
  /** Bar height in pixels for linear symbols. */
  barHeight?: number;
}

/** Deterministic noise, so a failure reproduces. */
function random(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

function cameraFrame(
  bitmap: { width: number; height: number; pixels: Uint8Array; linear: boolean },
  o: FrameOptions,
) {
  const dark = o.dark ?? 20;
  const light = o.light ?? 235;
  const scale = (FRAME_W * o.share) / bitmap.width;
  const symbolW = bitmap.width * scale;
  const symbolH = bitmap.linear ? (o.barHeight ?? 160) : bitmap.height * scale;
  const cx = FRAME_W / 2;
  const cy = FRAME_H / 2;
  const angle = ((o.tilt ?? 0) * Math.PI) / 180;
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  const rnd = random(bitmap.width * 31 + bitmap.height);
  const data = new Uint8ClampedArray(FRAME_W * FRAME_H * 4);
  for (let y = 0; y < FRAME_H; y++) {
    for (let x = 0; x < FRAME_W; x++) {
      // Rotate the frame point back into the symbol's coordinates.
      const dx = x - cx;
      const dy = y - cy;
      const u = dx * cos + dy * sin + symbolW / 2;
      const v = -dx * sin + dy * cos + symbolH / 2;
      let level = light;
      if (u >= 0 && u < symbolW && v >= 0 && v < symbolH) {
        const bx = Math.min(bitmap.width - 1, Math.floor(u / scale));
        const by = bitmap.linear ? 0 : Math.min(bitmap.height - 1, Math.floor(v / scale));
        level = bitmap.pixels[by * bitmap.width + bx]! < 128 ? dark : light;
      }
      const n = (rnd() - 0.5) * 2 * (o.noise ?? 0);
      const i = (y * FRAME_W + x) * 4;
      const value = level + n;
      data[i] = value;
      data[i + 1] = value;
      data[i + 2] = value;
      data[i + 3] = 255;
    }
  }
  return { data, width: FRAME_W, height: FRAME_H };
}

const options = { ...ZXING_READ_OPTIONS, formats: [...ZXING_READ_OPTIONS.formats] };

async function decode(
  symbology: Parameters<typeof barcodeBitmap>[0],
  code: string,
  frame: FrameOptions,
) {
  const found = await decodeFrame(cameraFrame(barcodeBitmap(symbology, code), frame), options);
  return found.map((f) => f.text);
}

describe('scanner decoding (zxing-wasm, the iPhone path)', () => {
  it('reads an EAN-13 product label, straight and tilted, in good and dim light', async () => {
    expect(await decode('ean13', '4006381333931', { share: 0.45 })).toEqual(['4006381333931']);
    expect(
      await decode('ean13', '5901234123457', {
        share: 0.4,
        tilt: 6,
        dark: 70,
        light: 140,
        noise: 12,
      }),
    ).toEqual(['5901234123457']);
  });

  it('reads a generated Code 128 case label', async () => {
    expect(await decode('code128', 'AS00000042', { share: 0.35, tilt: -4, noise: 8 })).toEqual([
      'AS00000042',
    ]);
  });

  it('reads a location label (QR of LOC: and the location ID)', async () => {
    const code = locationCode('01a1e347-bbaf-7ea1-9ed4-64d343029e04');
    expect(await decode('qr', code, { share: 0.3, tilt: 9, noise: 10 })).toEqual([code]);
    expect(await decode('qr', code, { share: 0.25, dark: 60, light: 130, noise: 10 })).toEqual([
      code,
    ]);
  });

  it('reads a QR code', async () => {
    expect(await decode('qr', 'AS00000043', { share: 0.2 })).toEqual(['AS00000043']);
  });

  it('reads a long Code 128 such as a grading-certificate slab label, close up', async () => {
    // A slab label packs a certificate number and card details into one dense Code 128.
    const code = 'CERT 84731629 POKEMON 2023 SV PAF 232 GEM MT 10';
    expect(code.length).toBeGreaterThan(40);
    expect(
      await decode('code128', code, { share: 0.92, tilt: 2, barHeight: 90, noise: 8 }),
    ).toEqual([code]);
    // Dim light under a plastic slab: low contrast.
    expect(
      await decode('code128', '84731629', { share: 0.5, dark: 80, light: 150, noise: 14 }),
    ).toEqual(['84731629']);
  });
});

describe('scan throttle', () => {
  it('reads a code once while it stays in view, and again after it left', () => {
    const t = new ScanThrottle(1500);
    expect(t.accept('A', 0)).toBe(true);
    // Seen every 100 ms for 5 s: never again.
    for (let at = 100; at <= 5000; at += 100) expect(t.accept('A', at)).toBe(false);
    // Out of view for longer than the quiet time: a second read counts.
    expect(t.accept('A', 6600)).toBe(true);
    // A different code counts at once, and so does the first one after it.
    expect(t.accept('B', 6700)).toBe(true);
    expect(t.accept('A', 6800)).toBe(true);
    t.reset();
    expect(t.accept('A', 6850)).toBe(true);
  });
});

describe('keyboard wedge', () => {
  it('takes fast keys ending in Enter as a scan, and ignores a person typing', () => {
    const w = new WedgeBuffer(60, 3);
    let at = 0;
    const type = (text: string, gap: number) => {
      let out: string | null = null;
      for (const ch of [...text, 'Enter']) {
        at += gap;
        out = w.key(ch, at) ?? out;
      }
      return out;
    };
    expect(type('4006381333931', 5)).toBe('4006381333931');
    expect(type('LOC:01A1E347-BBAF-7EA1-9ED4-64D343029E04', 3)).toBe(
      'LOC:01A1E347-BBAF-7EA1-9ED4-64D343029E04',
    );
    expect(type('123', 150)).toBeNull();
    expect(type('ab', 5)).toBeNull();
    // Shift and other named keys do not break a scan.
    let t = at + 1000;
    const next = () => {
      t += 3;
      return t;
    };
    expect(w.key('Shift', next())).toBeNull();
    for (const ch of 'AS42') w.key(ch, next());
    expect(w.key('Enter', next())).toBe('AS42');
  });
});
