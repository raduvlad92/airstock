/**
 * A small RFC 4180 CSV reader and writer (plan Section 10: no large dependency in the Worker).
 * Reads UTF-8 with or without a byte-order mark, comma or semicolon delimited, quoted fields with
 * doubled quotes and line breaks, and CRLF or LF line ends.
 */

export type Delimiter = ',' | ';';

/** Picks the delimiter that splits the header line into more fields, outside quotes. */
export function detectDelimiter(text: string): Delimiter {
  const line = firstLine(text);
  const count = (d: string) => {
    let n = 0;
    let quoted = false;
    for (const ch of line) {
      if (ch === '"') quoted = !quoted;
      else if (ch === d && !quoted) n++;
    }
    return n;
  };
  return count(';') > count(',') ? ';' : ',';
}

function firstLine(text: string): string {
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '"') quoted = !quoted;
    else if ((ch === '\n' || ch === '\r') && !quoted) return text.slice(0, i);
  }
  return text;
}

export class CsvError extends Error {
  constructor(
    readonly line: number,
    message: string,
  ) {
    super(message);
  }
}

/** All records, each an array of fields. Throws CsvError on an unterminated quote. */
export function parseCsv(input: string, delimiter: Delimiter = detectDelimiter(input)): string[][] {
  const text = input.charCodeAt(0) === 0xfeff ? input.slice(1) : input;
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  let line = 1;
  let startedQuote = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else {
        if (ch === '\n') line++;
        field += ch;
      }
      continue;
    }
    if (ch === '"' && field === '') {
      quoted = true;
      startedQuote = line;
    } else if (ch === delimiter) {
      row.push(field);
      field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
      line++;
    } else field += ch;
  }
  if (quoted)
    throw new CsvError(
      startedQuote,
      `A quoted field that starts on line ${startedQuote} never ends.`,
    );
  if (field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  // Blank lines carry no record.
  return rows.filter((r) => !(r.length === 1 && r[0] === ''));
}

/**
 * One CSV line. A text cell starting with =, +, -, or @ is prefixed with an apostrophe so a
 * spreadsheet does not run it as a formula (CSV injection); numbers keep their sign.
 */
export function csvLine(
  cells: Array<string | number | boolean | null | undefined>,
  delimiter: Delimiter = ',',
): string {
  return cells
    .map((cell) => {
      if (cell === null || cell === undefined) return '';
      let text = String(cell);
      if (typeof cell === 'string' && /^[=+\-@\t\r]/.test(text) && !/^[-+]?\d+(\.\d+)?$/.test(text))
        text = `'${text}`;
      return /["\n\r]/.test(text) || text.includes(delimiter)
        ? `"${text.replace(/"/g, '""')}"`
        : text;
    })
    .join(delimiter);
}
