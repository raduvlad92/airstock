import type { FontLoader } from '@airstock/pdf/fonts';

/**
 * Label fonts (ADR 0019). The shaping, script fallback, and glyph fixes live in `@airstock/pdf`,
 * shared with the Worker's purchase order PDFs; this module adds the browser's loader. Only the
 * pdf.ts chunk imports it, so fontkit stays out of the main bundle.
 */
export * from '@airstock/pdf/fonts';

export const FONT_PATH = '/assets/fonts/';

/** Loads a font file from the Worker's static assets, on the dashboard's origin. */
export const fetchFont: FontLoader = async (file) => {
  const res = await fetch(`${FONT_PATH}${file}`);
  if (!res.ok) throw new Error(`Could not load the label font ${file} (HTTP ${res.status}).`);
  return new Uint8Array(await res.arrayBuffer());
};
