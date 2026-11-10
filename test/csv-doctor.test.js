import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { analyze } from '../src/analyze.js';
import { clean } from '../src/clean.js';
import { detectDelimiter, parseCSV, toCSV } from '../src/parser.js';
import { parseDate, parseNumber } from '../src/values.js';

const issue = (report, id, column) => report.issues.find((i) => i.id === id && (column === undefined || i.column === column));
const run = (csv) => {
  const table = parseCSV(csv);
  return { table, report: analyze(table) };
};

test('parser handles quotes, escaped quotes, embedded newlines and CRLF', () => {
  const t = parseCSV('a,b\r\n"x,1","he said ""hi"""\r\n"two\nlines",z\r\n');
  assert.deepEqual(t.rows, [['x,1', 'he said "hi"'], ['two\nlines', 'z']]);
  assert.deepEqual(t.lines, [2, 3]);
});

test('source line numbers survive blank lines and multi-line values', () => {
  const t = parseCSV('a,b\n\n"1\n2",x\n3,y\n');
  assert.deepEqual(t.lines, [3, 5]);
});

test('delimiter detection copes with decimal commas', () => {
  assert.equal(detectDelimiter('name;price\nA;1,5\nB;2,5\n'), ';');
  assert.equal(detectDelimiter('a\tb\n1\t2\n'), '\t');
  assert.equal(detectDelimiter('a,b\n1,2\n'), ',');
});

test('written CSV parses back to the same table', () => {
  const t = parseCSV('a;b\n"x;y";"q""r"\n"l1\nl2";z\n');
  assert.deepEqual(parseCSV(toCSV(t)).rows, t.rows);
});

test('jagged rows and bad headers are repaired and reported', () => {
  const { table, report } = run('a,a,\n1,2\n1,2,3,4\n');
  assert.deepEqual(table.headers, ['a', 'a_2', 'column_3', 'column_4']);
  assert.deepEqual(table.rows[1], ['1', '2', '3', '4']);
  assert.equal(issue(report, 'short-rows').count, 1);
  assert.equal(issue(report, 'long-rows').count, 1);
  assert.equal(issue(report, 'headers').count, 3);
});

test('empty file is rejected', () => {
  assert.throws(() => parseCSV(''), /empty/);
});

test('numbers in US, Indonesian and currency formats', () => {
  const cases = { '1,234.5': '1234.5', '1.234,5': '1234.5', '1.234.567': '1234567', '12,5': '12.5', 'Rp 1.500': '1500', 'Rp. 1.500.000,50': '1500000.50', '-$20': '-20', 'Rp -5': '-5', '1.5': '1.5' };
  for (const [input, expected] of Object.entries(cases)) assert.equal(parseNumber(input)?.text, expected, input);
});

test('identifiers and junk are not numbers', () => {
  for (const value of ['0812345', '1,2,3', 'abc', '--5', '1.2.3']) assert.equal(parseNumber(value), null, value);
});

test('long IDs keep every digit', () => {
  assert.equal(parseNumber('12345678901234567890').text, '12345678901234567890');
});

test('impossible dates are rejected', () => {
  for (const value of ['2024-02-30', '31/31/2024', '32 Jan 2024']) assert.equal(parseDate(value), null, value);
  assert.equal(parseDate('2024-02-29').shape, 'YYYY-MM-DD');
});

test('finds missing values and placeholders', () => {
  const { report } = run('a,b\n1,x\n,y\nN/A,z\n4,w\n');
  const missing = issue(report, 'missing', 'a');
  assert.equal(missing.count, 2);
  assert.equal(missing.fix, 'placeholders');
});

test('wrong-type values are flagged but never changed', () => {
  const csv = `n\n${Array.from({ length: 9 }, (_, i) => i + 1).join('\n')}\noops\n`;
  const { table, report } = run(csv);
  assert.equal(issue(report, 'type-mismatch', 'n').examples[0].value, 'oops');
  assert.equal(clean(table).table.rows[9][0], 'oops');
});

test('outliers are flagged but kept', () => {
  const values = [10, 11, 12, 13, 14, 15, 16, 17, 5000];
  const { table, report } = run(`n\n${values.join('\n')}\n`);
  assert.equal(issue(report, 'outlier', 'n').count, 1);
  assert.equal(clean(table).table.rows.length, values.length);
});

test('leading-zero codes are treated as text', () => {
  const { report } = run('zip\n01234\n04567\n09876\n');
  assert.equal(report.columns[0].type, 'text');
});

test('clean trims, unifies case, blanks placeholders and drops duplicates', () => {
  const { table } = run('city,note,gone\n Jakarta ,x,\nJakarta,y,\njakarta,N/A,\nJakarta,x,\n,,\n');
  const result = clean(table);
  assert.deepEqual(result.table.headers, ['city', 'note']);
  assert.deepEqual(result.table.rows, [['Jakarta', 'x'], ['Jakarta', 'y'], ['Jakarta', '']]);
  assert.equal(result.log.duplicates, 1);
  assert.equal(result.log.emptyRows, 1);
  assert.equal(result.log.emptyColumns, 1);
});

test('treatments that are off do nothing', () => {
  const { table } = run('a,b\n x ,1\n x ,1\n');
  const result = clean(table, {});
  assert.deepEqual(result.table.rows, table.rows);
});

test('dates become ISO when the day/month order is provable', () => {
  const { table, report } = run('d\n25/12/2024\n03/01/2024\n2024-01-05\n7 Jan 2024\n');
  assert.ok(issue(report, 'date-format', 'd'));
  assert.deepEqual(clean(table).table.rows.flat(), ['2024-12-25', '2024-01-03', '2024-01-05', '2024-01-07']);
});

test('ambiguous day/month dates are left alone', () => {
  const { table } = run('d\n03/01/2024\n04/02/2024\n2024-01-05\n');
  assert.deepEqual(clean(table).table.rows.flat(), ['03/01/2024', '04/02/2024', '2024-01-05']);
});

test('formatted numbers become plain', () => {
  const { table } = run('p\n"1,500"\n$20\n300\n');
  assert.deepEqual(clean(table).table.rows.flat(), ['1500', '20', '300']);
});

test('a clean file scores 100 with no issues', () => {
  const { report } = run('name,age\nAni,20\nBudi,31\n');
  assert.equal(report.score, 100);
  assert.equal(report.issues.length, 0);
});

test('the sample improves after treatment', () => {
  const { table, report } = run(readFileSync(new URL('../samples/messy-sales.csv', import.meta.url), 'utf8'));
  const after = analyze(clean(table).table);
  assert.ok(report.issues.length >= 8);
  assert.ok(after.score > report.score);
  assert.ok(after.issues.some((i) => i.id === 'outlier'));
});

test('an empty row is one finding, not one per column', () => {
  const { report } = run('a,b\n1,x\n,\n3,y\n');
  assert.equal(issue(report, 'empty-rows').count, 1);
  assert.equal(report.issues.filter((i) => i.id === 'missing').length, 0);
});
