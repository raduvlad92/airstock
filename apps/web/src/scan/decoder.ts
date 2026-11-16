import { NATIVE_FORMATS, ZXING_BASE, ZXING_READ_OPTIONS } from './formats.ts';

/**
 * Decoders for camera frames (plan D13). The built-in BarcodeDetector is used where it exists
 * and reads the formats needed; everywhere else, including iOS Safari and the installed iOS app,
 * the vendored zxing-wasm 3.1.6 decodes. The app's CSP allows WebAssembly compilation
 * ('wasm-unsafe-eval') for it. The decoder script is loaded from this origin on first use, so
 * pages that never scan never download it.
 */
export interface Decoded {
  text: string;
  format: string;
}

export interface FrameDecoder {
  kind: 'native' | 'zxing';
  decode(video: HTMLVideoElement): Promise<Decoded[]>;
}

interface ZXingGlobal {
  prepareZXingModule(options: unknown): Promise<unknown>;
  readBarcodes(
    image: ImageData,
    options: Record<string, unknown>,
  ): Promise<Array<{ text: string; format: string; isValid: boolean }>>;
}

interface NativeDetector {
  detect(source: CanvasImageSource): Promise<Array<{ rawValue: string; format: string }>>;
}

interface NativeDetectorClass {
  new (options: { formats: string[] }): NativeDetector;
  getSupportedFormats(): Promise<string[]>;
}

/** Frames are scaled to this width before zxing reads them: fast enough on a phone (60–86 ms). */
const MAX_WIDTH = 1280;

let zxingReady: Promise<ZXingGlobal> | null = null;

/** Loads zxing-reader.js and compiles its wasm once per page. */
export function loadZxing(): Promise<ZXingGlobal> {
  zxingReady ??= new Promise<ZXingGlobal>((resolve, reject) => {
    const existing = (window as unknown as { ZXingWASM?: ZXingGlobal }).ZXingWASM;
    const prepare = (zxing: ZXingGlobal) =>
      zxing
        .prepareZXingModule({
          overrides: {
            locateFile: (path: string, prefix: string) =>
              path.endsWith('.wasm') ? ZXING_BASE + path : prefix + path,
          },
          fireImmediately: true,
        })
        .then(() => zxing);
    if (existing) {
      prepare(existing).then(resolve, reject);
      return;
    }
    const script = document.createElement('script');
    script.src = `${ZXING_BASE}zxing-reader.js`;
    script.async = true;
    script.onload = () => {
      const zxing = (window as unknown as { ZXingWASM?: ZXingGlobal }).ZXingWASM;
      if (!zxing) reject(new Error('The barcode decoder did not load.'));
      else prepare(zxing).then(resolve, reject);
    };
    script.onerror = () => reject(new Error('The barcode decoder could not be downloaded.'));
    document.head.append(script);
  }).catch((error: unknown) => {
    zxingReady = null;
    throw error;
  });
  return zxingReady;
}

async function nativeDecoder(): Promise<FrameDecoder | null> {
  const Detector = (window as unknown as { BarcodeDetector?: NativeDetectorClass }).BarcodeDetector;
  if (!Detector) return null;
  try {
    const supported = await Detector.getSupportedFormats();
    const formats = NATIVE_FORMATS.filter((f) => supported.includes(f));
    // Without the retail and Code 128 formats the built-in detector cannot do the job.
    if (!['ean_13', 'code_128', 'qr_code'].every((f) => supported.includes(f))) return null;
    const detector = new Detector({ formats });
    return {
      kind: 'native',
      async decode(video) {
        const found = await detector.detect(video);
        return found.map((f) => ({ text: f.rawValue, format: f.format }));
      },
    };
  } catch {
    return null;
  }
}

async function zxingDecoder(): Promise<FrameDecoder> {
  const zxing = await loadZxing();
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('This browser cannot read camera frames.');
  return {
    kind: 'zxing',
    async decode(video) {
      const scale = Math.min(1, MAX_WIDTH / video.videoWidth);
      const width = Math.round(video.videoWidth * scale);
      const height = Math.round(video.videoHeight * scale);
      if (width === 0 || height === 0) return [];
      if (canvas.width !== width) canvas.width = width;
      if (canvas.height !== height) canvas.height = height;
      ctx.drawImage(video, 0, 0, width, height);
      const found = await zxing.readBarcodes(ctx.getImageData(0, 0, width, height), {
        ...ZXING_READ_OPTIONS,
        formats: [...ZXING_READ_OPTIONS.formats],
      });
      return found.filter((f) => f.isValid).map((f) => ({ text: f.text, format: f.format }));
    },
  };
}

/** The built-in detector when it reads what we need, else zxing-wasm. */
export async function createDecoder(): Promise<FrameDecoder> {
  return (await nativeDecoder()) ?? zxingDecoder();
}

/** Whether this browser will need zxing, so the page can start downloading it early. */
export function needsZxing(): boolean {
  return !('BarcodeDetector' in window);
}
