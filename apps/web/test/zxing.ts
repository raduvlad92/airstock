import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInThisContext } from 'node:vm';

/**
 * The vendored zxing-wasm 3.1.6 reader (the build /scan-test loads in phones), run in Node. The
 * same script and wasm decode here as in the browser; only the wasm comes from disk instead of a
 * fetch. The dashboard's CSP has no 'wasm-unsafe-eval', so the decode test runs outside its page.
 */

interface ZXing {
  prepareZXingModule(options: unknown): Promise<unknown>;
  readBarcodes(
    image: { data: Uint8ClampedArray; width: number; height: number; colorSpace: 'srgb' },
    options: Record<string, unknown>,
  ): Promise<Array<{ format: string; text: string; isValid: boolean }>>;
}

// Plain paths: under happy-dom the global URL is the DOM's, which node:fs does not take.
const VENDOR = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../worker/public/assets/vendor/zxing-wasm-3.1.6',
);
let ready: Promise<ZXing> | null = null;

function load(): Promise<ZXing> {
  ready ??= (async () => {
    const global = globalThis as unknown as { ZXingWASM?: ZXing };
    if (!global.ZXingWASM) runInThisContext(readFileSync(join(VENDOR, 'zxing-reader.js'), 'utf8'));
    const zxing = global.ZXingWASM!;
    await zxing.prepareZXingModule({
      overrides: { wasmBinary: readFileSync(join(VENDOR, 'zxing_reader.wasm')) },
      fireImmediately: true,
    });
    return zxing;
  })();
  return ready;
}

/**
 * Decodes a grey image. A linear symbol's image is one band of bars that the PDF stretches to
 * the bar height; it is stretched the same way here.
 */
export async function decodeGrey(image: {
  width: number;
  height: number;
  pixels: Uint8Array;
}): Promise<Array<{ format: string; text: string }>> {
  const zxing = await load();
  const rows = image.height < 16 ? 48 : image.height;
  const data = new Uint8ClampedArray(image.width * rows * 4);
  for (let y = 0; y < rows; y++) {
    const source = Math.floor((y * image.height) / rows);
    for (let x = 0; x < image.width; x++) {
      const v = image.pixels[source * image.width + x]!;
      const i = (y * image.width + x) * 4;
      data[i] = v;
      data[i + 1] = v;
      data[i + 2] = v;
      data[i + 3] = 255;
    }
  }
  const found = await zxing.readBarcodes(
    { data, width: image.width, height: rows, colorSpace: 'srgb' },
    {
      formats: ['EAN13', 'EAN8', 'UPCA', 'Code128', 'QRCode'],
      tryHarder: true,
      maxNumberOfSymbols: 2,
    },
  );
  return found.filter((f) => f.isValid).map((f) => ({ format: f.format, text: f.text }));
}
