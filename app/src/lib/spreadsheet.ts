import { strFromU8, unzipSync } from 'fflate';

/**
 * Read a spreadsheet the admin picked into rows of text (2026-10-07, lead
 * import). Pure JavaScript, the same on the web and the phone:
 *
 *   .csv   — RFC 4180: quoted fields, "" escapes, commas/newlines in quotes
 *   .xlsx  — the FIRST sheet. An .xlsx file is a zip of XML parts; `fflate`
 *            unzips it and the sheet XML is read directly: shared strings,
 *            inline strings, numbers and booleans. Formulas give their cached
 *            value. Styles, dates-as-serials and merged cells are not
 *            interpreted — a lead list does not need them.
 *
 * Every cell comes back as a trimmed string ('' when empty), and every row
 * is padded to the same width.
 */

export type Sheet = string[][];

export function parseSpreadsheet(fileName: string, bytes: Uint8Array): Sheet {
  const lower = fileName.toLowerCase();
  if (lower.endsWith('.xlsx') || lower.endsWith('.xlsm')) return pad(parseXlsx(bytes));
  if (lower.endsWith('.xls')) throw new Error('Old .xls files are not supported — open it and save as .xlsx or .csv.');
  return pad(parseCsv(new TextDecoder('utf-8').decode(bytes)));
}

function pad(rows: Sheet): Sheet {
  const width = rows.reduce((w, r) => Math.max(w, r.length), 0);
  return rows.map((r) => {
    const out = r.map((c) => c.trim());
    while (out.length < width) out.push('');
    return out;
  });
}

export function parseCsv(text: string): Sheet {
  const rows: Sheet = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  const src = text.replace(/^﻿/, '');
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          quoted = false;
        }
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      quoted = true;
    } else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else {
      field += ch;
    }
  }
  if (field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
function decodeXml(s: string): string {
  return s.replace(/&(#x[0-9a-fA-F]+|#\d+|amp|lt|gt|quot|apos);/g, (_, e: string) =>
    e[0] === '#'
      ? String.fromCodePoint(e[1] === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10))
      : ENTITIES[e],
  );
}

/** All the <t> text inside one fragment (rich text runs are several <t>s). */
function textOf(fragment: string): string {
  let out = '';
  const re = /<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(fragment))) out += decodeXml(m[1]);
  return out;
}

/** "B" → 1, "AA" → 26 */
function columnIndex(ref: string): number {
  const letters = ref.replace(/[^A-Z]/g, '');
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

function parseXlsx(bytes: Uint8Array): Sheet {
  const files = unzipSync(bytes);
  // Some writers prefix every tag (`<x:row>`, `<x:c>`); drop tag prefixes so
  // one set of patterns reads both. Attributes (`r:id`) are left alone.
  const read = (path: string) =>
    files[path] ? strFromU8(files[path]).replace(/<(\/?)[A-Za-z][\w.-]*:(?=[A-Za-z])/g, '<$1') : null;

  // Which file is the first sheet: workbook.xml order → its relationship target.
  const workbook = read('xl/workbook.xml');
  const rels = read('xl/_rels/workbook.xml.rels');
  let sheetPath = 'xl/worksheets/sheet1.xml';
  const firstSheet = workbook?.match(/<sheet\b[^>]*\br:id="([^"]+)"/);
  if (firstSheet && rels) {
    const rel = new RegExp(`<Relationship\\b[^>]*\\bId="${firstSheet[1]}"[^>]*\\bTarget="([^"]+)"`).exec(rels)
      ?? new RegExp(`<Relationship\\b[^>]*\\bTarget="([^"]+)"[^>]*\\bId="${firstSheet[1]}"`).exec(rels);
    if (rel) sheetPath = rel[1].startsWith('/') ? rel[1].slice(1) : `xl/${rel[1].replace(/^\.\//, '')}`;
  }
  const sheet = read(sheetPath);
  if (!sheet) throw new Error('That spreadsheet has no readable first sheet.');

  const shared: string[] = [];
  const sst = read('xl/sharedStrings.xml');
  if (sst) {
    const re = /<si>([\s\S]*?)<\/si>/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(sst))) shared.push(textOf(m[1]));
  }

  const rows: Sheet = [];
  const rowRe = /<row\b([^>]*?)(?:\/>|>([\s\S]*?)<\/row>)/g;
  let rm: RegExpExecArray | null;
  while ((rm = rowRe.exec(sheet))) {
    const r = /\br="(\d+)"/.exec(rm[1])?.[1];
    const rowNumber = r ? Number(r) - 1 : rows.length;
    const cells: string[] = [];
    const cellRe = /<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g;
    let cm: RegExpExecArray | null;
    let next = 0;
    while ((cm = cellRe.exec(rm[2] ?? ''))) {
      const attrs = cm[1];
      const inner = cm[2] ?? '';
      const ref = /\br="([A-Z]+)\d+"/.exec(attrs)?.[1];
      const col = ref ? columnIndex(ref) : next;
      next = col + 1;
      const type = /\bt="([^"]+)"/.exec(attrs)?.[1];
      const v = /<v>([\s\S]*?)<\/v>/.exec(inner)?.[1];
      let value = '';
      if (type === 's' && v !== undefined) value = shared[Number(v)] ?? '';
      else if (type === 'inlineStr') value = textOf(inner);
      else if (type === 'b') value = v === '1' ? 'TRUE' : 'FALSE';
      else if (v !== undefined) value = decodeXml(v);
      while (cells.length < col) cells.push('');
      cells[col] = value;
    }
    while (rows.length < rowNumber) rows.push([]);
    rows[rowNumber] = cells;
  }
  return rows;
}
