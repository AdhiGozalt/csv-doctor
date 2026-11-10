// Browser UI. All file content reaches the page through textContent, never as HTML.
import { analyze } from './analyze.js';
import { TREATMENTS, clean } from './clean.js';
import { parseCSV, toCSV } from './parser.js';

const MAX_BYTES = 100 * 1024 * 1024;
const PREVIEW_ROWS = 200;
const VISIBLE_ISSUES = 40;

const $ = (id) => document.getElementById(id);
const fmt = (n) => n.toLocaleString('en-US', { maximumFractionDigits: 2 });
const plural = (n, word) => `${fmt(n)} ${word}${n === 1 ? '' : 's'}`;

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

let current = null;

function decode(buffer) {
  const bytes = new Uint8Array(buffer);
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder('utf-16le').decode(bytes);
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder('utf-16be').decode(bytes);
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    return new TextDecoder('windows-1252').decode(bytes);
  }
}

function showError(message) {
  $('error').textContent = message;
  $('error').hidden = false;
}

function load(name, text) {
  try {
    const table = parseCSV(text);
    if (table.rows.length === 0) throw new Error('This file has a header row but no data.');
    current = { name, table, report: analyze(table), potential: clean(table).log };
    $('error').hidden = true;
    render();
  } catch (error) {
    showError(error.message);
  }
}

async function loadFile(file) {
  if (!file) return;
  if (file.size > MAX_BYTES) {
    showError('That file is over 100 MB, which is more than a browser tab handles comfortably.');
    return;
  }
  load(file.name, decode(await file.arrayBuffer()));
}

function verdict(score) {
  if (score >= 90) return ['Healthy', 'var(--good)'];
  if (score >= 70) return ['Needs care', 'var(--medium)'];
  return ['Critical', 'var(--high)'];
}

function renderIssues({ issues }) {
  $('issue-count').textContent = issues.length ? plural(issues.length, 'finding') : '';
  const list = $('issues');
  list.replaceChildren();
  if (issues.length === 0) {
    list.append(el('p', 'healthy', 'No problems found. This file is in good shape.'));
    return;
  }
  for (const issue of issues.slice(0, VISIBLE_ISSUES)) {
    const row = el('article', 'issue');
    const title = el('h3', '', issue.title);
    if (issue.column !== null) title.append(el('code', '', issue.column));
    row.append(el('span', `badge ${issue.severity}`, issue.severity), title, el('span', 'n', issue.count ? `×${fmt(issue.count)}` : ''), el('p', '', issue.detail));
    if (issue.examples.length && issue.id !== 'empty-column' && issue.id !== 'empty-rows') {
      const samples = issue.examples.map((e) => `line ${e.line}: ${e.value.trim() === '' ? '(empty)' : e.value.length > 70 ? `${e.value.slice(0, 70)}…` : e.value}`);
      row.append(el('p', 'examples', samples.join('   ·   ')));
    }
    list.append(row);
  }
  if (issues.length > VISIBLE_ISSUES) list.append(el('p', 'healthy', `…and ${issues.length - VISIBLE_ISSUES} more.`));
}

function renderTreatments() {
  const box = $('treatments');
  box.replaceChildren();
  for (const [id, label] of TREATMENTS) {
    const count = current.potential[id];
    const row = el('label', count ? '' : 'none');
    const input = el('input');
    input.type = 'checkbox';
    input.dataset.treatment = id;
    input.checked = count > 0;
    input.disabled = count === 0;
    input.addEventListener('change', updateResult);
    row.append(input, el('span', '', label), el('em', '', count ? fmt(count) : 'none'));
    box.append(row);
  }
}

function selectedTreatments() {
  const options = {};
  for (const input of document.querySelectorAll('[data-treatment]')) options[input.dataset.treatment] = input.checked;
  return options;
}

function updateResult() {
  const { table, report } = current;
  const result = clean(table, selectedTreatments());
  const after = analyze(result.table);
  current.cleaned = result.table;
  $('before').textContent = report.score;
  $('after').textContent = after.score;
  const removed = report.rowCount - after.rowCount;
  const remaining = after.issues.filter((i) => i.severity !== 'low').length;
  $('after-note').textContent = `${removed ? `${plural(removed, 'row')} removed. ` : ''}${remaining ? `${plural(remaining, 'finding')} left for you to review.` : 'Nothing left to review.'}`;
}

function renderColumns({ columns, rowCount }) {
  const head = el('tr');
  for (const title of ['Column', 'Type', 'Filled', 'Unique', 'Min', 'Median', 'Max']) head.append(el('th', '', title));
  const rows = columns.map((column) => {
    const tr = el('tr');
    const share = rowCount ? column.filled / rowCount : 0;
    const filled = el('td', 'num');
    const bar = el('span', 'bar');
    const fill = el('i');
    fill.style.width = `${share * 100}%`;
    bar.append(fill);
    filled.append(bar, `${Math.round(share * 100)}%`);
    const stat = (key) => el('td', 'num', column.stats ? fmt(column.stats[key]) : '');
    tr.append(el('td', '', column.name), el('td', '', column.type), filled, el('td', 'num', fmt(column.unique)), stat('min'), stat('median'), stat('max'));
    return tr;
  });
  $('columns').replaceChildren(el('thead'), el('tbody'));
  $('columns').tHead.append(head);
  $('columns').tBodies[0].append(...rows);
}

function renderPreview({ table, report }) {
  const head = el('tr');
  head.append(el('th', '', 'Line'));
  for (const name of table.headers) head.append(el('th', '', name));
  const width = table.headers.length;
  const body = table.rows.slice(0, PREVIEW_ROWS).map((row, r) => {
    const tr = el('tr');
    tr.append(el('td', 'line', table.lines[r]));
    row.forEach((value, c) => {
      const flagged = report.flagged[r * width + c] === 1;
      const td = el('td', `${flagged ? 'flag ' : ''}${value === '' ? 'blank' : ''}`);
      if (value !== '') {
        const cell = el('span', 'cell', value);
        cell.title = value;
        td.append(cell);
      }
      tr.append(td);
    });
    return tr;
  });
  $('preview').replaceChildren(el('thead'), el('tbody'));
  $('preview').tHead.append(head);
  $('preview').tBodies[0].append(...body);
  const shown = table.rows.length > PREVIEW_ROWS ? `Showing the first ${PREVIEW_ROWS} of ${fmt(table.rows.length)} rows. ` : '';
  $('preview-note').textContent = `${shown}Highlighted cells have at least one finding.`;
}

function render() {
  const { name, table, report } = current;
  const delimiterName = { ',': 'comma', ';': 'semicolon', '\t': 'tab', '|': 'pipe' }[table.delimiter];
  $('file-name').textContent = name;
  $('file-meta').textContent = `${plural(report.rowCount, 'row')} · ${plural(report.columnCount, 'column')} · ${delimiterName} separated`;
  $('score').textContent = report.score;
  const [label, tone] = verdict(report.score);
  $('verdict').textContent = label;
  $('score-box').style.setProperty('--tone', tone);
  renderIssues(report);
  renderTreatments();
  updateResult();
  renderColumns(report);
  renderPreview(current);
  $('intake').hidden = true;
  $('report').hidden = false;
  window.scrollTo(0, 0);
}

$('file').addEventListener('change', (event) => loadFile(event.target.files[0]));

$('sample').addEventListener('click', async () => {
  try {
    const response = await fetch('samples/messy-sales.csv');
    if (!response.ok) throw new Error();
    load('messy-sales.csv', await response.text());
  } catch {
    showError('The sample could not be loaded. Please try again.');
  }
});

$('restart').addEventListener('click', () => {
  current = null;
  $('file').value = '';
  $('report').hidden = true;
  $('intake').hidden = false;
});

$('download').addEventListener('click', () => {
  const url = URL.createObjectURL(new Blob([toCSV(current.cleaned)], { type: 'text/csv;charset=utf-8' }));
  const link = el('a');
  link.href = url;
  link.download = `${current.name.replace(/\.[^.]+$/, '')}.cleaned.csv`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});

const drop = $('drop');
for (const type of ['dragenter', 'dragover']) {
  drop.addEventListener(type, (event) => {
    event.preventDefault();
    drop.classList.add('over');
  });
}
for (const type of ['dragleave', 'drop']) {
  drop.addEventListener(type, (event) => {
    event.preventDefault();
    drop.classList.remove('over');
  });
}
drop.addEventListener('drop', (event) => loadFile(event.dataTransfer.files[0]));
