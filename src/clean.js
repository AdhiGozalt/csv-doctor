// Applies the safe, mechanical fixes. Outliers and wrong-type values are left for a human.
import { profileColumn } from './analyze.js';
import { dateToIso, isBlank, isPlaceholder, parseDate, parseNumber, spellingGroups, tidy } from './values.js';

export const TREATMENTS = [
  ['trim', 'Remove extra spaces'],
  ['placeholders', 'Blank out N/A, null and "-"'],
  ['caseVariants', 'Unify capitalisation'],
  ['numbers', 'Convert formatted numbers to plain numbers'],
  ['dates', 'Standardise mixed dates to YYYY-MM-DD'],
  ['emptyColumns', 'Drop empty columns'],
  ['emptyRows', 'Drop empty rows'],
  ['duplicates', 'Drop duplicate rows'],
];

export const ALL_TREATMENTS = Object.fromEntries(TREATMENTS.map(([id]) => [id, true]));

export function clean(table, options = ALL_TREATMENTS) {
  const log = Object.fromEntries(TREATMENTS.map(([id]) => [id, 0]));
  let headers = [...table.headers];
  let rows = table.rows.map((row) => [...row]);
  const lines = rows.map((_, i) => i + 2);

  const eachCell = (id, change) => {
    for (const row of rows) {
      row.forEach((value, c) => {
        const next = change(value);
        if (next !== value) {
          row[c] = next;
          log[id]++;
        }
      });
    }
  };
  if (options.trim) eachCell('trim', tidy);
  if (options.placeholders) eachCell('placeholders', (v) => (isPlaceholder(v) ? '' : v));

  headers.forEach((name, c) => {
    const values = rows.map((row) => row[c]);
    const column = profileColumn(name, c, values, lines);
    const hasIssue = (id) => column.issues.some((issue) => issue.id === id);
    const replace = (id, change) => {
      rows.forEach((row) => {
        const next = change(row[c]);
        if (next !== null && next !== row[c]) {
          row[c] = next;
          log[id]++;
        }
      });
    };

    if (options.caseVariants && hasIssue('case-variants')) {
      const groups = spellingGroups(values);
      replace('caseVariants', (v) => {
        const group = isBlank(v) ? null : groups.get(tidy(v).toLowerCase());
        return group && tidy(v) !== group.preferred ? group.preferred : null;
      });
    }
    if (options.numbers && hasIssue('number-format')) replace('numbers', (v) => parseNumber(v)?.text ?? null);
    if (options.dates && hasIssue('date-format')) {
      replace('dates', (v) => {
        const parsed = isBlank(v) ? null : parseDate(v);
        return parsed ? dateToIso(parsed, column.dateOrder) : null;
      });
    }
  });

  if (options.emptyColumns) {
    const keep = headers.map((_, c) => rows.length === 0 || rows.some((row) => !isBlank(row[c])));
    log.emptyColumns = keep.filter((k) => !k).length;
    if (log.emptyColumns > 0) {
      headers = headers.filter((_, c) => keep[c]);
      rows = rows.map((row) => row.filter((_, c) => keep[c]));
    }
  }
  if (options.emptyRows) {
    const before = rows.length;
    rows = rows.filter((row) => !row.every(isBlank));
    log.emptyRows = before - rows.length;
  }
  if (options.duplicates) {
    const seen = new Set();
    const before = rows.length;
    rows = rows.filter((row) => {
      if (row.every(isBlank)) return true;
      const key = row.map(tidy).join('\u0001');
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    log.duplicates = before - rows.length;
  }

  return {
    table: { ...table, headers, rows, lines: rows.map((_, i) => i + 2), headerFixes: [], shortRows: [], longRows: [], unterminatedQuote: false },
    log,
  };
}
