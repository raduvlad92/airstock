/**
 * The symbologies the scanner reads (plan D13, PRD 3.4): retail codes on products and cases,
 * Code 128 for internal and grading-certificate labels, Code 39, 93, and ITF that older cases
 * and slabs use, and QR and Data Matrix for location labels and 2D codes. One list for the
 * built-in BarcodeDetector and one for zxing-wasm, so both decoders accept the same codes.
 */
export const NATIVE_FORMATS = [
  'ean_13',
  'ean_8',
  'upc_a',
  'upc_e',
  'code_128',
  'code_39',
  'code_93',
  'itf',
  'qr_code',
  'data_matrix',
] as const;

export const ZXING_FORMATS = [
  'EAN13',
  'EAN8',
  'UPCA',
  'UPCE',
  'Code128',
  'Code39',
  'Code93',
  'ITF',
  'QRCode',
  'DataMatrix',
] as const;

/** Options for zxing's readBarcodes, shared by the phone and the Node decode tests. */
export const ZXING_READ_OPTIONS = {
  formats: [...ZXING_FORMATS],
  tryHarder: true,
  maxNumberOfSymbols: 1,
} as const;

/** Where the Worker serves the vendored decoder (apps/worker/public/assets/vendor). */
export const ZXING_BASE = '/assets/vendor/zxing-wasm-3.1.6/';
