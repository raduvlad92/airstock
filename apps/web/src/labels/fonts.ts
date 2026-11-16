import fontkit, { type Font, type Glyph } from '@pdf-lib/fontkit';
import bidiFactory from 'bidi-js';
import regeneratorRuntime from 'regenerator-runtime';

/**
 * Label fonts (ADR 0019). Self-hosted Noto fonts under /assets/fonts: Noto Sans for Latin, Greek,
 * and Cyrillic, and one family per further script, fetched only when a label's text needs it.
 * fontkit shapes each run of text, the bidi algorithm orders runs, and the PDF and the preview
 * both use the result, so they measure and draw the same glyphs.
 *
 * Only the pdf.ts chunk imports this module, so fontkit stays out of the main bundle.
 */

// fontkit's Indic and Universal shapers (Devanagari) run a transpiled generator that expects the
// regenerator runtime as a global.
const scope = globalThis as { regeneratorRuntime?: unknown };
scope.regeneratorRuntime ??= regeneratorRuntime;

export const FONT_PATH = '/assets/fonts/';

interface Family {
  key: string;
  regular: string;
  /** Without a bold file, bold text is the regular glyphs with a thin outline. */
  bold: string | null;
  /** Characters that need this family when Noto Sans lacks them. */
  needs: RegExp;
}

const BASE = { key: 'sans', regular: 'NotoSans-Regular.ttf', bold: 'NotoSans-Bold.ttf' };

/** In order of preference when two families have a character. */
export const SCRIPT_FAMILIES: Family[] = [
  {
    key: 'arabic',
    regular: 'NotoSansArabic-Regular.ttf',
    bold: 'NotoSansArabic-Bold.ttf',
    needs: /\p{scx=Arab}/u,
  },
  {
    key: 'hebrew',
    regular: 'NotoSansHebrew-Regular.ttf',
    bold: 'NotoSansHebrew-Bold.ttf',
    needs: /\p{scx=Hebr}/u,
  },
  {
    key: 'thai',
    regular: 'NotoSansThai-Regular.ttf',
    bold: 'NotoSansThai-Bold.ttf',
    needs: /\p{scx=Thai}/u,
  },
  {
    key: 'devanagari',
    regular: 'NotoSansDevanagari-Regular.ttf',
    bold: 'NotoSansDevanagari-Bold.ttf',
    needs: /\p{scx=Deva}/u,
  },
  {
    // Simplified Chinese glyphs; also kana and the kanji in CJK Unified Ideographs. No Hangul.
    key: 'cjk',
    regular: 'NotoSansSC-Regular.ttf',
    bold: null,
    needs: /[\p{scx=Hani}\p{scx=Hira}\p{scx=Kana}\p{scx=Bopo}　-〿＀-￯]/u,
  },
];

/** Outline width of synthetic bold, as a share of the font size. */
export const SYNTHETIC_BOLD = 0.03;

export interface Face {
  file: string;
  font: Font;
  /** The font file as pdf-lib embeds it (see `evenGlyphs`). */
  bytes: Uint8Array;
  /** Bold drawn as the regular glyphs with an outline. */
  synthetic: boolean;
}

export interface LabelText {
  text: string;
  bold: boolean;
}

/** One stretch of a line drawn in one font, left to right. */
export interface Run {
  face: Face;
  /** What to shape: fontkit returns its glyphs in left-to-right order. */
  text: string;
  glyphs: Glyph[];
  /** From the line's start, in ems. */
  x: number;
  advance: number;
}

export interface Line {
  runs: Run[];
  /** In ems. */
  advance: number;
}

const IGNORABLE = /\p{Default_Ignorable_Code_Point}/gu;

/** Text as it prints: composed (so "ș" is one character), spaces collapsed, invisibles dropped. */
export function prepare(text: string): string {
  return text.normalize('NFC').replace(/\s+/g, ' ').replace(IGNORABLE, '');
}

/**
 * fontkit writes a subset's glyph offsets in the short `loca` format, which halves them, so one
 * glyph record of odd length shifts every glyph after it and the PDF shows wrong or missing
 * letters. Some Noto builds have odd-length records (unhinted Noto Sans, Noto Sans SC). This pads
 * each record to an even length; a font that needs no padding comes back as is.
 */
export function evenGlyphs(bytes: Uint8Array): Uint8Array {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const count = view.getUint16(4);
  const tables = new Map<string, { record: number; offset: number; length: number }>();
  for (let i = 0; i < count; i++) {
    const record = 12 + 16 * i;
    tables.set(String.fromCharCode(...bytes.subarray(record, record + 4)), {
      record,
      offset: view.getUint32(record + 8),
      length: view.getUint32(record + 12),
    });
  }
  const head = tables.get('head');
  const maxp = tables.get('maxp');
  const loca = tables.get('loca');
  const glyf = tables.get('glyf');
  // CFF outlines have no loca; short offsets are always even.
  if (!head || !maxp || !loca || !glyf || view.getInt16(head.offset + 50) !== 1) return bytes;
  const glyphs = view.getUint16(maxp.offset + 4);
  const offsets = Array.from({ length: glyphs + 1 }, (_, i) => view.getUint32(loca.offset + 4 * i));
  if (offsets.every((o) => o % 2 === 0)) return bytes;

  const padded = [0];
  for (let i = 0; i < glyphs; i++) {
    const length = offsets[i + 1]! - offsets[i]!;
    padded.push(padded[i]! + length + (length % 2));
  }
  const newGlyf = new Uint8Array(padded[glyphs]!);
  for (let i = 0; i < glyphs; i++)
    newGlyf.set(
      bytes.subarray(glyf.offset + offsets[i]!, glyf.offset + offsets[i + 1]!),
      padded[i],
    );
  const newLoca = new Uint8Array(4 * (glyphs + 1));
  const locaView = new DataView(newLoca.buffer);
  for (const [i, o] of padded.entries()) locaView.setUint32(4 * i, o);

  const data = (tag: string, t: { offset: number; length: number }) =>
    tag === 'glyf'
      ? newGlyf
      : tag === 'loca'
        ? newLoca
        : bytes.subarray(t.offset, t.offset + t.length);
  const header = 12 + 16 * count;
  let size = header;
  for (const [tag, t] of tables) size += (data(tag, t).length + 3) & ~3;
  const out = new Uint8Array(size);
  const outView = new DataView(out.buffer);
  out.set(bytes.subarray(0, header));
  let at = header;
  for (const [tag, t] of tables) {
    const table = data(tag, t);
    out.set(table, at);
    if (tag === 'glyf' || tag === 'loca') {
      let sum = 0;
      for (let i = 0; i < table.length; i += 4) sum = (sum + outView.getUint32(at + i)) >>> 0;
      outView.setUint32(t.record + 4, sum);
    }
    outView.setUint32(t.record + 8, at);
    outView.setUint32(t.record + 12, table.length);
    at += (table.length + 3) & ~3;
  }
  return out;
}

const bidi = bidiFactory();
/** Spaces, punctuation, digits, and marks: they stay in the font of the text around them. */
const SHARED = /[\p{Script=Common}\p{Script=Inherited}]/u;
const SCRIPTED = /[^\p{Script=Common}\p{Script=Inherited}\p{Script=Unknown}]/u;
const RTL_SCRIPT = /[\p{Script=Arab}\p{Script=Hebr}\p{Script=Syrc}\p{Script=Thaa}\p{Script=Nkoo}]/u;
const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

/** fontkit takes a run's direction from its first character with a script. */
const shapesRtl = (text: string) => {
  const first = SCRIPTED.exec(text);
  return first !== null && RTL_SCRIPT.test(first[0]);
};

const reversed = (text: string) =>
  Array.from(graphemes.segment(text), (s) => s.segment)
    .reverse()
    .join('');

interface Item {
  face: Face;
  level: number;
  text: string;
}

/**
 * Splits a line into runs by font, orders them with the Unicode bidirectional algorithm (the
 * paragraph direction comes from the first strong character), and shapes each run.
 */
function layoutLine(text: string, chain: Face[]): Line {
  const { levels } = bidi.getEmbeddingLevels(text, 'auto');
  const mirrored = bidi.getMirroredCharactersMap(text, levels);
  const items: Item[] = [];
  let face: Face | null = null;
  let index = 0;
  for (const original of text) {
    const ch = mirrored.get(index) ?? original;
    const level = levels[index]!;
    index += original.length;
    const code = ch.codePointAt(0)!;
    if (!(face && SHARED.test(ch) && face.font.hasGlyphForCodePoint(code)))
      face = chain.find((f) => f.font.hasGlyphForCodePoint(code)) ?? chain[0]!;
    const last = items.at(-1);
    if (last && last.face === face && last.level === level) last.text += ch;
    else items.push({ face, level, text: ch });
  }
  // Rule L2: from the highest level down to the lowest odd one, reverse each sequence of items at
  // that level or above.
  const max = Math.max(...items.map((i) => i.level));
  const min = Math.min(...items.map((i) => i.level));
  for (let level = max; level >= (min % 2 ? min : min + 1); level--) {
    for (let start = 0; start < items.length; start++) {
      if (items[start]!.level < level) continue;
      let end = start;
      while (end + 1 < items.length && items[end + 1]!.level >= level) end++;
      items.splice(start, end - start + 1, ...items.slice(start, end + 1).reverse());
      start = end;
    }
  }
  const runs: Run[] = [];
  let x = 0;
  for (const item of items) {
    // An odd level reads right to left. fontkit reverses a run whose script is right to left, so
    // the text goes in reversed whenever that does not match the level.
    const shaped =
      (item.level % 2 === 1) !== shapesRtl(item.text) ? reversed(item.text) : item.text;
    const glyphs = item.face.font.layout(shaped).glyphs;
    const advance = glyphs.reduce((w, g) => w + g.advanceWidth, 0) / item.face.font.unitsPerEm;
    runs.push({ face: item.face, text: shaped, glyphs, x, advance });
    x += advance;
  }
  return { runs, advance: x };
}

/** The loaded fonts for one print job or preview, as metrics for the label planner. */
export class LabelFonts {
  readonly #lines = new Map<string, Line>();

  /** Characters in the texts that no font has; they print as "?". */
  readonly missing: string[];

  constructor(
    readonly regular: Face[],
    readonly bold: Face[],
    texts: LabelText[],
  ) {
    const missing = new Set<string>();
    for (const t of texts)
      for (const ch of prepare(t.text)) if (!this.covers(ch, t.bold)) missing.add(ch);
    this.missing = [...missing];
  }

  covers(ch: string, bold: boolean): boolean {
    const code = ch.codePointAt(0)!;
    return (bold ? this.bold : this.regular).some((f) => f.font.hasGlyphForCodePoint(code));
  }

  /** The text as it prints: see `prepare`, and "?" for a character no font has. */
  clean(text: string, bold: boolean): string {
    let out = '';
    for (const ch of prepare(text)) out += this.covers(ch, bold) ? ch : '?';
    return out;
  }

  line(text: string, bold: boolean): Line {
    const key = `${bold ? 'b' : 'r'}${text}`;
    let line = this.#lines.get(key);
    if (!line) {
      line = text ? layoutLine(text, bold ? this.bold : this.regular) : { runs: [], advance: 0 };
      this.#lines.set(key, line);
    }
    return line;
  }

  /** Width in points of one line of text at a size. */
  width(text: string, size: number, bold: boolean): number {
    return this.line(text, bold).advance * size;
  }
}

export type FontLoader = (file: string) => Promise<Uint8Array>;

/** Loads a font file from the Worker's static assets, on the dashboard's origin. */
export const fetchFont: FontLoader = async (file) => {
  const res = await fetch(`${FONT_PATH}${file}`);
  if (!res.ok) throw new Error(`Could not load the label font ${file} (HTTP ${res.status}).`);
  return new Uint8Array(await res.arrayBuffer());
};

/** Font files, each loaded once and only when a text needs it. */
export class FontLibrary {
  readonly #files = new Map<string, Promise<{ bytes: Uint8Array; font: Font }>>();

  constructor(private readonly load: FontLoader) {}

  #face(family: { regular: string; bold: string | null }, bold: boolean): Promise<Face> {
    const file = (bold && family.bold) || family.regular;
    let loaded = this.#files.get(file);
    if (!loaded) {
      loaded = this.load(file).then((raw) => {
        const bytes = evenGlyphs(raw);
        return { bytes, font: fontkit.create(bytes) };
      });
      // A failed download is tried again next time.
      loaded.catch(() => this.#files.delete(file));
      this.#files.set(file, loaded);
    }
    return loaded.then(({ bytes, font }) => ({
      file,
      font,
      bytes,
      synthetic: bold && !family.bold,
    }));
  }

  /** Noto Sans, plus each script family that a character Noto Sans lacks needs. */
  async fontsFor(texts: LabelText[]): Promise<LabelFonts> {
    const weights = texts.some((t) => t.bold) ? [false, true] : [false];
    const chains = new Map<boolean, Face[]>();
    for (const bold of weights) {
      const base = await this.#face(BASE, bold);
      const wanted = new Set<Family>();
      for (const t of texts) {
        if (t.bold !== bold) continue;
        for (const ch of prepare(t.text)) {
          if (base.font.hasGlyphForCodePoint(ch.codePointAt(0)!)) continue;
          const family = SCRIPT_FAMILIES.find((f) => f.needs.test(ch));
          if (family) wanted.add(family);
        }
      }
      const extra = SCRIPT_FAMILIES.filter((f) => wanted.has(f)).map((f) => this.#face(f, bold));
      chains.set(bold, [base, ...(await Promise.all(extra))]);
    }
    const regular = chains.get(false)!;
    return new LabelFonts(regular, chains.get(true) ?? regular, texts);
  }
}
