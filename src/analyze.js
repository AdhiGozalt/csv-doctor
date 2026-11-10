// Turns a parsed table into a column profile, a list of issues and a quality score.
import { classify, isBlank, isMissing, isPlaceholder, parseDate, parseNumber, resolveDateOrder, spellingGroups, tidy } from './values.js';

const DOMINANT_SHARE = 0.8;
const OUTLIER_FENCE = 3; // Tukey's "far out" fence: fewer false alarms on skewed business data.
const OUTLIER_MIN_VALUES = 8;
const SEVERITY_ORDER = { high: 0, medium: 1, low: 2 };

function quantile(sorted, q) {
  const position = (sorted.length - 1) * q;
  const low = Math.floor(position);
  const high = Math.ceil(position);
  return sorted[low] + (sorted[high] - sorted[low]) * (position - low);
}

function dominantType(counts, filled) {
  const [type, seen] = Object.entries(counts).sort((a, b) => b[1] - a[1])[0] || ['empty', 0];
  if (filled === 0) return 'empty';
  return seen / filled >= DOMINANT_SHARE ? type : 'text';
}

/** Profiles one column. `lines` gives each row's source line for the examples in the report. */
export function profileColumn(name, index, values, lines, blankRows = new Set()) {
  const issues = [];
  const addIssue = (id, severity, title, detail, rows, fix) => {
    issues.push({
      id, severity, column: name, columnIndex: index, title, detail, rows, count: rows.length, fix,
      examples: rows.slice(0, 3).map((r) => ({ line: lines[r], value: values[r] })),
    });
  };

  const present = [];
  const missing = [];
  const placeholders = [];
  const untidy = [];
  const typeCounts = {};
  const types = values.map((value, r) => {
    if (blankRows.has(r)) return null; // Reported once as an empty row, not once per column.
    if (value !== tidy(value) && !isBlank(value)) untidy.push(r);
    if (isMissing(value)) {
      missing.push(r);
      if (isPlaceholder(value)) placeholders.push(r);
      return null;
    }
    present.push(r);
    const type = classify(value);
    typeCounts[type] = (typeCounts[type] || 0) + 1;
    return type;
  });

  const type = dominantType(typeCounts, present.length);
  const unique = new Set(present.map((r) => tidy(values[r]))).size;
  const column = { name, index, type, filled: present.length, missing: missing.length, placeholders: placeholders.length, unique, stats: null, dateOrder: null, issues };

  if (type === 'empty') {
    if (values.length > 0) addIssue('empty-column', 'high', 'Column is completely empty', 'No row has a value here.', missing, 'emptyColumns');
    return column;
  }

  if (missing.length > 0) {
    const share = missing.length / values.length;
    const extra = placeholders.length ? ` ${placeholders.length} use a stand-in such as "N/A" or "-".` : '';
    addIssue('missing', share >= 0.3 ? 'high' : 'medium', 'Missing values', `${Math.round(share * 100)}% of this column is empty.${extra}`, missing, placeholders.length ? 'placeholders' : undefined);
  }
  if (untidy.length > 0) addIssue('whitespace', 'low', 'Extra spaces', 'Stray spaces make identical values look different.', untidy, 'trim');

  if (type !== 'text') {
    const mismatched = present.filter((r) => types[r] !== type);
    if (mismatched.length > 0) addIssue('type-mismatch', 'high', `Not a ${type}`, `This column holds ${type} values, but these do not fit. They need a human decision, so they are never changed automatically.`, mismatched);
  }

  if (type === 'number') {
    const parsed = present.map((r) => [r, parseNumber(values[r])]).filter(([, n]) => n);
    const formatted = parsed.filter(([, n]) => !n.plain).map(([r]) => r);
    if (formatted.length > 0) addIssue('number-format', 'medium', 'Numbers stored with formatting', 'Currency symbols and thousands separators stop tools from reading these as numbers.', formatted, 'numbers');

    const sorted = parsed.map(([, n]) => n.value).sort((a, b) => a - b);
    const sum = sorted.reduce((total, v) => total + v, 0);
    column.stats = { min: sorted[0], max: sorted[sorted.length - 1], mean: sum / sorted.length, median: quantile(sorted, 0.5) };

    if (sorted.length >= OUTLIER_MIN_VALUES) {
      const q1 = quantile(sorted, 0.25);
      const q3 = quantile(sorted, 0.75);
      const iqr = q3 - q1;
      if (iqr > 0) {
        const low = q1 - OUTLIER_FENCE * iqr;
        const high = q3 + OUTLIER_FENCE * iqr;
        const outliers = parsed.filter(([, n]) => n.value < low || n.value > high).map(([r]) => r);
        if (outliers.length > 0) addIssue('outlier', 'medium', 'Extreme values', `Far outside the typical range (${low.toLocaleString('en-US')} to ${high.toLocaleString('en-US')}). Could be real, so they are only flagged.`, outliers);
      }
    }
  }

  if (type === 'date') {
    const parsed = present.map((r) => [r, parseDate(values[r])]).filter(([, d]) => d);
    const shapeCounts = new Map();
    for (const [, d] of parsed) shapeCounts.set(d.shape, (shapeCounts.get(d.shape) || 0) + 1);
    column.dateOrder = resolveDateOrder(parsed.map(([, d]) => d));
    if (shapeCounts.size > 1) {
      const main = [...shapeCounts].sort((a, b) => b[1] - a[1])[0][0];
      const unclear = parsed.some(([, d]) => d.numeric) && !column.dateOrder;
      const note = unclear ? ' Day and month order cannot be proven for some values, so those stay as they are.' : '';
      addIssue('date-format', 'medium', 'Mixed date formats', `${shapeCounts.size} formats in one column.${note}`, parsed.filter(([, d]) => d.shape !== main).map(([r]) => r), 'dates');
    }
  }

  if (type === 'text') {
    const groups = spellingGroups(values);
    if (groups.size > 0) {
      const affected = present.filter((r) => {
        const group = groups.get(tidy(values[r]).toLowerCase());
        return group && tidy(values[r]) !== group.preferred;
      });
      const sample = [...groups.values()][0].spellings.slice(0, 3).join(', ');
      addIssue('case-variants', 'medium', 'Same value, different capitalisation', `${groups.size} value${groups.size > 1 ? 's are' : ' is'} spelled more than one way, for example ${sample}.`, affected, 'caseVariants');
    }
  }

  if (unique === 1 && values.length > 1) addIssue('constant', 'low', 'Only one distinct value', 'A column that never changes adds nothing to an analysis.', []);
  return column;
}

/** Runs every check on a parsed table. */
export function analyze(table) {
  const { headers, rows, lines } = table;
  const blankRows = new Set();
  rows.forEach((row, r) => {
    if (row.every(isBlank)) blankRows.add(r);
  });
  const columns = headers.map((name, c) => profileColumn(name, c, rows.map((r) => r[c]), lines, blankRows));
  const issues = columns.flatMap((column) => column.issues);

  const emptyRows = [];
  const duplicateRows = [];
  const seen = new Set();
  rows.forEach((row, r) => {
    if (row.every(isBlank)) {
      emptyRows.push(r);
      return;
    }
    const key = row.map(tidy).join('\u0001');
    if (seen.has(key)) duplicateRows.push(r);
    else seen.add(key);
  });

  const rowIssue = (id, severity, title, detail, rowIndexes, fix) => ({
    id, severity, column: null, columnIndex: null, title, detail, rows: rowIndexes, count: rowIndexes.length, fix,
    examples: rowIndexes.slice(0, 3).map((r) => ({ line: lines[r], value: rows[r].join(' · ') })),
  });
  if (duplicateRows.length > 0) issues.push(rowIssue('duplicates', 'high', 'Duplicate rows', 'These rows repeat an earlier row exactly and would be double counted.', duplicateRows, 'duplicates'));
  if (emptyRows.length > 0) issues.push(rowIssue('empty-rows', 'medium', 'Empty rows', 'Rows made only of delimiters.', emptyRows, 'emptyRows'));

  const fileIssue = (id, severity, title, detail, count) => issues.push({ id, severity, column: null, columnIndex: null, title, detail, rows: [], count, examples: [] });
  const lineList = (list) => `Line${list.length > 1 ? 's' : ''} ${list.slice(0, 8).join(', ')}${list.length > 8 ? ', …' : ''}.`;
  if (table.shortRows.length) fileIssue('short-rows', 'high', 'Rows with too few fields', `${lineList(table.shortRows)} Missing fields were read as empty, but later values may have shifted.`, table.shortRows.length);
  if (table.longRows.length) fileIssue('long-rows', 'high', 'Rows with too many fields', `${lineList(table.longRows)} Extra values were placed in new columns so nothing is lost. An unquoted delimiter is the usual cause.`, table.longRows.length);
  if (table.headerFixes.length) fileIssue('headers', 'low', 'Blank or repeated headers', table.headerFixes.map((f) => `"${f.from}" read as "${f.to}"`).join(', ') + '.', table.headerFixes.length);
  if (table.unterminatedQuote) fileIssue('unterminated-quote', 'high', 'Unclosed quotation mark', 'A quote is never closed, so the end of the file may have been read as one value.', 1);

  issues.sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] || b.count - a.count);

  // A cell with several problems is counted once.
  const width = headers.length;
  const flagged = new Uint8Array(rows.length * width);
  for (const issue of issues) {
    for (const r of issue.rows) {
      if (issue.columnIndex !== null) {
        flagged[r * width + issue.columnIndex] = 1;
      } else {
        flagged.fill(1, r * width, (r + 1) * width);
      }
    }
  }
  const problemCells = flagged.reduce((total, v) => total + v, 0);
  const totalCells = flagged.length;
  let score = totalCells === 0 ? 0 : Math.round(100 * (1 - problemCells / totalCells));
  if (problemCells > 0 && score === 100) score = 99;

  return { rowCount: rows.length, columnCount: width, totalCells, problemCells, score, columns, issues, flagged };
}
