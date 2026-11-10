// Understanding what a single cell contains.

const PLACEHOLDERS = new Set(['na', 'n/a', '#n/a', 'null', 'none', 'nan', 'nil', '-', '--', '?']);
const BOOLEANS = new Set(['true', 'false', 'yes', 'no']);
const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, mei: 5, jun: 6, jul: 7, aug: 8, agu: 8, agt: 8, sep: 9, oct: 10, okt: 10, nov: 11, dec: 12, des: 12 };

/** Removes outer whitespace and runs of spaces, leaving line breaks inside a value alone. */
export const tidy = (value) => value.trim().replace(/[ \t]{2,}/g, ' ');

export const isBlank = (value) => value.trim() === '';
export const isPlaceholder = (value) => PLACEHOLDERS.has(value.trim().toLowerCase());
export const isMissing = (value) => isBlank(value) || isPlaceholder(value);

/**
 * Reads 1234.5, 1,234.5, 1.234,5, 1234,5 and currency forms such as Rp 1.500.000.
 * Works on strings throughout, so long IDs never lose digits to floating point.
 * Numbers with leading zeros (phone numbers, postal codes) are identifiers and return null.
 */
export function parseNumber(raw) {
  const value = raw.trim();
  const match = value.match(/^([-+]?)\s*(rp\.?|idr|usd|\$|€|£)?\s*([-+]?)([\d.,]+)$/i);
  if (!match || !/\d/.test(match[4]) || (match[1] && match[3])) return null;
  const sign = match[1] === '-' || match[3] === '-' ? '-' : '';
  const rupiah = /^(rp|idr)/i.test(match[2] || '');
  const body = match[4];
  if (/^0\d+$/.test(body)) return null;

  let digits;
  if (/^(\d+(\.\d+)?|\.\d+)$/.test(body)) {
    digits = rupiah && /^\d{1,3}(\.\d{3})+$/.test(body) ? body.replace(/\./g, '') : body;
  } else if (/^\d{1,3}(,\d{3})+(\.\d+)?$/.test(body)) {
    digits = body.replace(/,/g, '');
  } else if (/^\d{1,3}(\.\d{3})+(,\d+)?$/.test(body)) {
    digits = body.replace(/\./g, '').replace(',', '.');
  } else if (/^\d+,\d+$/.test(body)) {
    digits = body.replace(',', '.');
  } else {
    return null;
  }
  const text = sign + digits;
  return { text, value: Number(text), plain: value === text };
}

function realDate(year, month, day) {
  const d = new Date(Date.UTC(year, month - 1, day));
  return d.getUTCFullYear() === year && d.getUTCMonth() === month - 1 && d.getUTCDate() === day;
}

const iso = (y, m, d) => `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;

/** Returns the date's shape and, when a date is unambiguous, its ISO form. */
export function parseDate(raw) {
  const value = raw.trim();
  let m = value.match(/^(\d{4})-(\d{1,2})-(\d{1,2})(?:[ T]\d{1,2}:\d{2}.*)?$/);
  if (m) return realDate(+m[1], +m[2], +m[3]) ? { shape: 'YYYY-MM-DD', iso: null, keep: true } : null;

  m = value.match(/^(\d{4})\/(\d{1,2})\/(\d{1,2})$/);
  if (m) return realDate(+m[1], +m[2], +m[3]) ? { shape: 'YYYY/MM/DD', iso: iso(+m[1], +m[2], +m[3]) } : null;

  m = value.match(/^(\d{1,2})([/.-])(\d{1,2})\2(\d{4})$/);
  if (m) {
    const [a, b, y] = [+m[1], +m[3], +m[4]];
    const asDmy = realDate(y, b, a);
    const asMdy = realDate(y, a, b);
    if (!asDmy && !asMdy) return null;
    const sep = m[2];
    return { shape: `??${sep}??${sep}YYYY`, numeric: { a, b, y }, order: asDmy && asMdy ? null : asDmy ? 'dmy' : 'mdy' };
  }

  m = value.match(/^(\d{1,2})\s+([a-z]{3,9})\.?,?\s+(\d{4})$/i);
  if (m) {
    const month = MONTHS[m[2].slice(0, 3).toLowerCase()];
    return month && realDate(+m[3], month, +m[1]) ? { shape: 'D Month YYYY', iso: iso(+m[3], month, +m[1]) } : null;
  }
  m = value.match(/^([a-z]{3,9})\.?\s+(\d{1,2}),?\s+(\d{4})$/i);
  if (m) {
    const month = MONTHS[m[1].slice(0, 3).toLowerCase()];
    return month && realDate(+m[3], month, +m[2]) ? { shape: 'Month D, YYYY', iso: iso(+m[3], month, +m[2]) } : null;
  }
  return null;
}

/** Decides day/month order for a column: dmy, mdy, or null when the values cannot settle it. */
export function resolveDateOrder(parsedDates) {
  const numeric = parsedDates.filter((d) => d.numeric);
  const sawDmy = numeric.some((d) => d.order === 'dmy');
  const sawMdy = numeric.some((d) => d.order === 'mdy');
  if (sawDmy === sawMdy) return null;
  return sawDmy ? 'dmy' : 'mdy';
}

export function dateToIso(parsed, order) {
  if (parsed.iso) return parsed.iso;
  if (parsed.numeric && order) {
    const { a, b, y } = parsed.numeric;
    return order === 'dmy' ? iso(y, b, a) : iso(y, a, b);
  }
  return null;
}

export function classify(value) {
  if (BOOLEANS.has(value.trim().toLowerCase())) return 'boolean';
  if (parseNumber(value)) return 'number';
  if (parseDate(value)) return 'date';
  return 'text';
}

/** Finds values that differ only by letter case, and the most common spelling of each. */
export function spellingGroups(values) {
  const groups = new Map();
  for (const value of values) {
    if (isMissing(value)) continue;
    const spelling = tidy(value);
    const key = spelling.toLowerCase();
    if (!groups.has(key)) groups.set(key, new Map());
    const spellings = groups.get(key);
    spellings.set(spelling, (spellings.get(spelling) || 0) + 1);
  }
  const result = new Map();
  for (const [key, spellings] of groups) {
    if (spellings.size > 1) {
      const preferred = [...spellings].sort((a, b) => b[1] - a[1])[0][0];
      result.set(key, { preferred, spellings: [...spellings.keys()] });
    }
  }
  return result;
}
