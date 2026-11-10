// RFC 4180 style CSV reading and writing, with delimiter detection.

const DELIMITERS = [',', ';', '\t', '|'];

/** Splits text into rows. Records the line each row starts on, so reports can point at the source. */
export function parseRows(text, delimiter) {
  const rows = [];
  const lines = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  let fieldWasQuoted = false;
  let line = 1;
  let rowStart = 1;

  const endField = () => {
    row.push(field);
    field = '';
  };
  const endRow = () => {
    endField();
    const blankLine = row.length === 1 && row[0] === '' && !fieldWasQuoted;
    if (!blankLine) {
      rows.push(row);
      lines.push(rowStart);
    }
    row = [];
    fieldWasQuoted = false;
  };

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        if (ch === '\n') line++;
        field += ch;
      }
    } else if (ch === '"' && field === '') {
      inQuotes = true;
      fieldWasQuoted = true;
    } else if (ch === delimiter) {
      endField();
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      endRow();
      line++;
      rowStart = line;
    } else {
      field += ch;
    }
  }

  const unterminatedQuote = inQuotes;
  if (field !== '' || row.length > 0 || fieldWasQuoted) endRow();
  return { rows, lines, unterminatedQuote };
}

/** Picks the delimiter that gives the most consistent column count over the first rows. */
export function detectDelimiter(text) {
  const sample = text.slice(0, 64 * 1024);
  let best = ',';
  let bestScore = 0;
  for (const candidate of DELIMITERS) {
    const counts = parseRows(sample, candidate).rows.slice(0, 50).map((r) => r.length);
    if (counts.length === 0) continue;
    const frequency = new Map();
    for (const c of counts) frequency.set(c, (frequency.get(c) || 0) + 1);
    const [mode, seen] = [...frequency].sort((a, b) => b[1] - a[1] || b[0] - a[0])[0];
    if (mode < 2) continue;
    const score = seen / counts.length + mode / 10000;
    if (score > bestScore) {
      bestScore = score;
      best = candidate;
    }
  }
  return best;
}

/** Parses a whole file into a rectangular table, reporting whatever had to be repaired. */
export function parseCSV(input) {
  const hasBom = input.charCodeAt(0) === 0xfeff;
  const text = hasBom ? input.slice(1) : input;
  const delimiter = detectDelimiter(text);
  const { rows, lines, unterminatedQuote } = parseRows(text, delimiter);
  if (rows.length === 0) throw new Error('This file is empty.');

  const width = Math.max(...rows.map((r) => r.length));
  const headerFixes = [];
  const used = new Set();
  const headers = [];
  for (let c = 0; c < width; c++) {
    const original = (rows[0][c] ?? '').trim();
    const base = original || `column_${c + 1}`;
    let name = base;
    for (let n = 2; used.has(name); n++) name = `${base}_${n}`;
    used.add(name);
    headers.push(name);
    if (name !== original) headerFixes.push({ from: original, to: name });
  }

  const body = rows.slice(1);
  const bodyLines = lines.slice(1);
  const expected = rows[0].length;
  const shortRows = [];
  const longRows = [];
  body.forEach((row, i) => {
    if (row.length < expected) shortRows.push(bodyLines[i]);
    if (row.length > expected) longRows.push(bodyLines[i]);
    while (row.length < width) row.push('');
  });

  return { headers, rows: body, lines: bodyLines, delimiter, hasBom, headerFixes, shortRows, longRows, unterminatedQuote };
}

function quoteField(value, delimiter) {
  const mustQuote = value.includes('"') || value.includes('\n') || value.includes('\r') || value.includes(delimiter);
  return mustQuote ? `"${value.replace(/"/g, '""')}"` : value;
}

export function toCSV({ headers, rows, delimiter = ',', hasBom = false }) {
  const body = [headers, ...rows].map((row) => row.map((v) => quoteField(v, delimiter)).join(delimiter)).join('\r\n');
  return `${hasBom ? '﻿' : ''}${body}\r\n`;
}
