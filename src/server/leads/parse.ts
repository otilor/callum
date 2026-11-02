import { parse } from 'csv-parse/sync';
import type { LeadSource, PersonLead } from '../../shared/types.js';
import { normalizeEmail, normalizeLinkedinUrl, normalizeXHandle } from '../db/handles.js';

export type SkipReason = 'duplicate' | 'known' | 'stopped' | 'no_channel' | 'other_project';
export interface Skipped {
  name: string;
  reason: SkipReason;
  /** The project the person is already in, for `other_project`. */
  projectName?: string;
  /** The line of the file or paste the person came from (1-based), when there is one. */
  row?: number;
}
export interface ParseResult { people: PersonLead[]; skipped: Skipped[] }

/** The file cannot be read at all (no header, a quote that never closes). The message is for the person who chose the file. */
export class ImportFileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ImportFileError';
  }
}

// ---- reading bytes -------------------------------------------------------------

/**
 * Turns the bytes of an uploaded list into text. Excel saves CSVs as Windows-1252, "Unicode text" as UTF-16
 * with a BOM, and most other tools as UTF-8 (often with a BOM).
 */
export function decodeLeadFile(bytes: Uint8Array): string {
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return new TextDecoder('utf-8').decode(bytes);
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder('utf-16le').decode(bytes);
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder('utf-16be').decode(bytes);
  const utf16 = sniffUtf16(bytes);
  if (utf16) return new TextDecoder(utf16).decode(bytes);
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return new TextDecoder('windows-1252').decode(bytes);
  }
}

/** UTF-16 without a BOM: mostly ASCII text, so one byte of every pair is zero. */
function sniffUtf16(bytes: Uint8Array): 'utf-16le' | 'utf-16be' | null {
  const n = Math.min(bytes.length - (bytes.length % 2), 400);
  if (n < 4) return null;
  let even = 0;
  let odd = 0;
  for (let i = 0; i < n; i++) if (bytes[i] === 0) (i % 2 === 0 ? even++ : odd++);
  const pairs = n / 2;
  if (odd > pairs * 0.3 && even === 0) return 'utf-16le';
  if (even > pairs * 0.3 && odd === 0) return 'utf-16be';
  return null;
}

function stripBom(text: string): string {
  // A UTF-8 BOM that was decoded as Windows-1252 shows up as "ï»¿".
  return text.replace(/^(?:﻿|ï»¿)/, '');
}

// ---- cleaning values -----------------------------------------------------------

const PLACEHOLDER = /^(?:n\/?a|none|null|nil|unknown|undefined|[-–—.?]+)$/i;
const EMAIL_IN_TEXT = /[^\s<>"'(),;:[\]]+@[^\s<>"'(),;:[\]@]+\.[a-z]{2,}/gi;
const LOCKED_EMAIL = /^email_not_unlocked@/i;

/** Plain text from a cell: line breaks and runs of spaces become one space; placeholders become null. */
function cleanText(raw: string | undefined | null): string | null {
  const v = (raw ?? '').replace(/\s+/g, ' ').trim();
  return v === '' || PLACEHOLDER.test(v) ? null : v;
}

/** The first usable email in a cell ("Name <a@b.com>", "a@b.com ::: c@d.com"); Apollo's locked placeholder is not one. */
export function cleanEmail(raw: string | undefined | null): string | null {
  for (const m of (raw ?? '').matchAll(EMAIL_IN_TEXT)) {
    if (LOCKED_EMAIL.test(m[0])) continue;
    const e = normalizeEmail(m[0]);
    if (e) return e;
  }
  return null;
}

function cleanTimezone(raw: string | undefined | null): string | null {
  const v = cleanText(raw);
  if (!v) return null;
  try {
    return new Intl.DateTimeFormat('en-US', { timeZone: v }).resolvedOptions().timeZone;
  } catch {
    return null;
  }
}

function localPart(email: string): string {
  return email.slice(0, email.indexOf('@'));
}

/** "femi-ade-3a1b2c4" becomes "Femi Ade": the trailing id LinkedIn adds is dropped. */
function nameFromLinkedin(url: string): string | null {
  const slug = /\/in\/([^/?#]+)/.exec(url)?.[1] ?? '';
  let readable = slug;
  try {
    readable = decodeURIComponent(slug);
  } catch {
    // Not valid UTF-8 escapes: keep the slug as written.
  }
  const words = readable.split(/[-_]+/).filter(Boolean);
  const last = words[words.length - 1];
  if (words.length > 1 && last && /\d/.test(last) && (last.length >= 5 || /^\d+$/.test(last))) words.pop();
  const name = words.map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
  return name || null;
}

/** A name for someone whose list gave none: the email's local part, else the LinkedIn slug, else the X handle. */
export function fallbackName(p: { email?: string | null; linkedinUrl?: string | null; xHandle?: string | null }): string | null {
  const email = normalizeEmail(p.email);
  if (email) return localPart(email);
  const linkedin = normalizeLinkedinUrl(p.linkedinUrl);
  if (linkedin) return nameFromLinkedin(linkedin);
  const x = normalizeXHandle(p.xHandle);
  return x ? `@${x}` : null;
}

// ---- one person, from either reader -------------------------------------------------

interface Parts {
  name: string | null; first: string | null; email: string | null; company: string | null; role: string | null;
  linkedinUrl: string | null; xHandle: string | null; timezone: string | null;
}

/** Keys that identify a person, normalised, for catching repeats. */
export function identityKeys(p: { email?: string | null; linkedinUrl?: string | null; xHandle?: string | null }): string[] {
  const keys: string[] = [];
  const email = normalizeEmail(p.email);
  const linkedin = normalizeLinkedinUrl(p.linkedinUrl);
  const x = normalizeXHandle(p.xHandle);
  if (email) keys.push(`email:${email}`);
  if (linkedin) keys.push(`linkedin:${linkedin}`);
  if (x) keys.push(`x:${x}`);
  return keys;
}

/** Collects people and skipped rows from a file, dropping repeats inside the file. */
class Collector {
  readonly people: PersonLead[] = [];
  readonly skipped: Skipped[] = [];
  private readonly seen = new Set<string>();

  constructor(private readonly source: LeadSource) {}

  add(parts: Parts, row: number): void {
    const name = parts.name ?? fallbackName(parts) ?? parts.company ?? `Row ${row}`;
    const person: PersonLead = { name, source: this.source, row };
    if (parts.first) person.firstName = parts.first;
    if (parts.company) person.company = parts.company;
    if (parts.role) person.role = parts.role;
    if (parts.email) person.email = parts.email;
    if (parts.linkedinUrl) person.linkedinUrl = parts.linkedinUrl;
    if (parts.xHandle) person.xHandle = parts.xHandle;
    if (parts.timezone) person.timezone = parts.timezone;

    const keys = identityKeys(person);
    if (keys.length === 0) {
      this.skipped.push({ name, reason: 'no_channel', row });
    } else if (keys.some((k) => this.seen.has(k))) {
      this.skipped.push({ name, reason: 'duplicate', row });
    } else {
      keys.forEach((k) => this.seen.add(k));
      this.people.push(person);
    }
  }

  result(): ParseResult {
    return { people: this.people, skipped: this.skipped };
  }
}

// ---- headers ---------------------------------------------------------------------

type Field = 'name' | 'first' | 'last' | 'email' | 'company' | 'role' | 'linkedin' | 'x' | 'timezone';

/** Header spellings per field, best first (a work email beats a personal one when a row has both). */
const ALIASES: Record<Field, string[]> = {
  name: ['name', 'full name', 'fullname', 'contact name', 'display name', 'person name'],
  first: ['first name', 'firstname', 'given name', 'first'],
  last: ['last name', 'lastname', 'surname', 'family name', 'last'],
  email: [
    'email', 'work email', 'email address', 'e mail', 'e mail address', 'work e mail', 'business email', 'primary email',
    'e mail 1 value', 'email 1', 'email 1 value', 'e mail 2 value', 'email 2', 'email 2 value', 'secondary email',
    'personal email', 'e mail 3 value', 'email 3', 'tertiary email',
  ],
  company: [
    'company', 'company name', 'organization', 'organisation', 'organization name', 'organization 1 name', 'account',
    'account name', 'associated company', 'employer', 'current company',
  ],
  role: [
    'job title', 'position', 'title', 'role', 'headline', 'organization title', 'organization 1 title', 'current title',
    'job role', 'occupation',
  ],
  linkedin: [
    'linkedin', 'linkedin url', 'linkedin profile', 'linkedin profile url', 'linkedin link', 'person linkedin url', 'profile',
    'profile url', 'default profile url', 'profile link', 'url', 'website 1 value', 'website 2 value', 'website 3 value',
  ],
  x: ['x', 'twitter', 'x handle', 'twitter handle', 'x username', 'twitter username', 'x profile', 'twitter profile'],
  timezone: ['timezone', 'time zone', 'tz'],
};
const IDENTITY: Field[] = ['name', 'first', 'last', 'email', 'linkedin', 'x'];

const ALIAS_LOOKUP = new Map<string, { field: Field; rank: number }>();
for (const [field, names] of Object.entries(ALIASES) as Array<[Field, string[]]>) {
  names.forEach((n, rank) => ALIAS_LOOKUP.set(n, { field, rank }));
}

const squashHeader = (s: string): string => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

/** The known field for a heading, trying it as written first ("LinkedIn") and then split at camelCase ("profileUrl"). */
function lookupHeader(cell: string): { field: Field; rank: number } | undefined {
  return ALIAS_LOOKUP.get(squashHeader(cell)) ?? ALIAS_LOOKUP.get(squashHeader(cell.replace(/([\p{Ll}\p{N}])(\p{Lu})/gu, '$1 $2')));
}

const looksLikeData = (cell: string): boolean => {
  const v = cell.trim();
  return /^https?:\/\//i.test(v) || v.startsWith('@') || cleanEmail(v) !== null;
};

type Columns = Record<Field, number[]>;

/** The columns of a header row, or null when the row does not look like a header. */
function readHeader(cells: string[]): { columns: Columns; score: number } | null {
  const found: Array<{ field: Field; rank: number; index: number }> = [];
  cells.forEach((cell, index) => {
    if (looksLikeData(cell)) return;
    const hit = lookupHeader(cell);
    if (hit) found.push({ ...hit, index });
  });
  if (!found.some((f) => IDENTITY.includes(f.field))) return null;
  if (cells.some(looksLikeData)) return null;
  const columns: Columns = { name: [], first: [], last: [], email: [], company: [], role: [], linkedin: [], x: [], timezone: [] };
  found.sort((a, b) => a.rank - b.rank || a.index - b.index);
  for (const f of found) columns[f.field].push(f.index);
  return { columns, score: found.length };
}

// ---- tables ------------------------------------------------------------------------------

const DELIMITERS = [',', ';', '\t', '|'] as const;
type Delimiter = (typeof DELIMITERS)[number];
const HEADER_SEARCH_ROWS = 60;

interface Rec { cells: string[]; line: number }

const parseOptions = (delimiter: Delimiter) => ({
  delimiter,
  relax_column_count: true,
  relax_quotes: true,
  skip_empty_lines: true,
  info: true,
});

function readRecords(text: string, delimiter: Delimiter, limit?: number): Rec[] {
  const rows = parse(text, { ...parseOptions(delimiter), ...(limit ? { to: limit } : {}) }) as unknown as Array<{ record: string[]; info: { lines: number } }>;
  return rows.map(({ record, info }) => {
    // csv-parse reports the line a record ends on; a quoted cell with line breaks starts earlier.
    const breaks = record.reduce((n, c) => n + (c.match(/\n/g)?.length ?? 0), 0);
    return { cells: record, line: info.lines - breaks };
  });
}

/** The line a quote that never closes was opened on, found the way the parser reads quotes. */
function unclosedQuoteLine(text: string, delimiter: Delimiter): number | null {
  let line = 1;
  let openedOn = 0;
  let inQuote = false;
  let atFieldStart = true;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuote) {
      if (ch === '"') {
        if (text[i + 1] === '"') i++;
        else {
          const next = text[i + 1];
          if (next === undefined || next === delimiter || next === '\n' || next === '\r') { inQuote = false; atFieldStart = false; }
        }
      } else if (ch === '\n') line++;
      continue;
    }
    if (ch === '\n') { line++; atFieldStart = true; }
    else if (ch === delimiter) atFieldStart = true;
    else if (ch === '\r') continue;
    else if (ch === '"' && atFieldStart) { inQuote = true; openedOn = line; atFieldStart = false; }
    else atFieldStart = false;
  }
  return inQuote ? openedOn : null;
}

const NO_HEADER =
  'Callum could not find a column for names, emails or LinkedIn links in this file. ' +
  'Put headings like Name, Email or LinkedIn in the first row, or paste the list instead.';

interface Table { delimiter: Delimiter; headerAt: number; columns: Columns }

function findTable(text: string): { table: Table } | { error: ImportFileError; noHeader: boolean } {
  let best: (Table & { score: number }) | null = null;
  let readError: unknown = null;
  for (const delimiter of DELIMITERS) {
    let records: Rec[];
    try {
      records = readRecords(text, delimiter, HEADER_SEARCH_ROWS);
    } catch (e) {
      readError = readError ?? e;
      continue;
    }
    for (const [i, rec] of records.entries()) {
      const header = readHeader(rec.cells);
      if (!header) continue;
      if (!best || header.score > best.score) best = { delimiter, headerAt: i, columns: header.columns, score: header.score };
      break;
    }
  }
  if (best) return { table: best };
  const quoteLine = readError ? DELIMITERS.map((d) => unclosedQuoteLine(text, d)).find((n) => n !== null) ?? null : null;
  if (quoteLine) return { error: quoteError(quoteLine), noHeader: false };
  return { error: new ImportFileError(NO_HEADER), noHeader: true };
}

const quoteError = (line: number): ImportFileError =>
  new ImportFileError(`A quote that opens near line ${line} is never closed, so Callum can't tell where that row ends. Close it or take it out, and try again.`);

/** A "Title" of Mr. / Ms. / Dr. (Outlook) is a salutation, not a job title. */
const HONORIFIC = /^(?:mr|mrs|ms|miss|mx|dr|prof|sir|madam|mister|master|rev|hon)\.?$/i;

function pick(cells: string[], cols: number[], accept: (v: string) => boolean = () => true): string | null {
  for (const c of cols) {
    const v = cleanText(cells[c]);
    if (v && accept(v)) return v;
  }
  return null;
}

function readTable(raw: string, source: LeadSource): ParseResult {
  const text = stripBom(raw);
  if (text.trim() === '') return { people: [], skipped: [] };
  const found = findTable(text);
  if ('error' in found) {
    if (!found.noHeader) throw found.error;
    // No heading row: read it as one person per line, as a paste. If that finds nobody either, say what is missing.
    const lines = parseLines(text, source);
    if (lines.people.length === 0) throw found.error;
    return lines;
  }
  const { delimiter, headerAt, columns } = found.table;

  let records: Rec[];
  try {
    records = readRecords(text, delimiter);
  } catch (e) {
    const line = unclosedQuoteLine(text, delimiter);
    if (line) throw quoteError(line);
    throw new ImportFileError(`Callum could not read this file: ${e instanceof Error ? e.message : String(e)}`);
  }

  const rows = records.slice(headerAt + 1);
  const out = new Collector(source);
  for (const rec of rows) {
    const cells = rec.cells;
    if (cells.every((c) => c.trim() === '')) continue;
    const first = pick(cells, columns.first);
    const last = pick(cells, columns.last);
    let email: string | null = null;
    for (const c of columns.email) if (!email) email = cleanEmail(cells[c]);
    let linkedinUrl: string | null = null;
    for (const c of columns.linkedin) if (!linkedinUrl) linkedinUrl = normalizeLinkedinUrl(cells[c]);
    let xHandle: string | null = null;
    for (const c of columns.x) if (!xHandle) xHandle = normalizeXHandle(cleanText(cells[c]));
    out.add(
      {
        name: pick(cells, columns.name) ?? ([first, last].filter(Boolean).join(' ') || null),
        first,
        email,
        company: pick(cells, columns.company),
        role: pick(cells, columns.role, (v) => !HONORIFIC.test(v)),
        linkedinUrl,
        xHandle,
        timezone: cleanTimezone(pick(cells, columns.timezone)),
      },
      rec.line,
    );
  }
  return out.result();
}

/** A CSV, TSV or semicolon-separated list, with the header anywhere in the first rows. */
export function parseCsv(text: string): ParseResult {
  return readTable(text, 'csv');
}

// ---- paste ------------------------------------------------------------------------------------

function splitLine(line: string): string[] {
  const delimiter = line.includes('\t') ? '\t' : line.includes('|') ? '|' : line.includes(',') ? ',' : line.includes(';') ? ';' : null;
  if (!delimiter) return [line];
  const fields: string[] = [];
  let cur = '';
  let inQuote = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (inQuote) {
      if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; } else if (ch === '"') inQuote = false; else cur += ch;
    } else if (ch === '"' && cur.trim() === '') inQuote = true;
    else if (ch === delimiter) { fields.push(cur); cur = ''; } else cur += ch;
  }
  fields.push(cur);
  return fields;
}

const X_URL = /(?:^|\/\/)(?:[a-z0-9-]+\.)*(?:x|twitter)\.com\//i;

/** One person per line, with names, emails, LinkedIn links and @handles recognised by their shape. */
function parsePasteLine(line: string): Parts {
  const parts: Parts = { name: null, first: null, email: null, company: null, role: null, linkedinUrl: null, xHandle: null, timezone: null };
  const texts: string[] = [];
  for (const field of splitLine(line)) {
    const words: string[] = [];
    for (const token of field.trim().split(/\s+/).filter(Boolean)) {
      const bare = token.replace(/^[<("']+|[>)"',;]+$/g, '');
      const email = cleanEmail(bare);
      if (email && bare.includes('@') && !bare.startsWith('@')) { parts.email ??= email; continue; }
      if (/linkedin\.com\//i.test(bare)) { parts.linkedinUrl ??= normalizeLinkedinUrl(bare); continue; }
      if (X_URL.test(bare) || (bare.startsWith('@') && normalizeXHandle(bare))) { parts.xHandle ??= normalizeXHandle(bare); continue; }
      words.push(token);
    }
    const text = cleanText(words.join(' '));
    if (text) texts.push(text);
  }
  [parts.name, parts.company, parts.role] = [texts[0] ?? null, texts[1] ?? null, texts[2] ?? null];
  return parts;
}

/** A line with nothing but emails on it ("a@x.com, b@y.com; c@z.com") is several people. */
function emailsOnly(line: string): string[] | null {
  const emails = [...line.matchAll(EMAIL_IN_TEXT)].map((m) => m[0]);
  if (emails.length < 2) return null;
  const rest = line.replace(EMAIL_IN_TEXT, '').replace(/[\s,;<>"']/g, '');
  return rest === '' ? emails : null;
}

function startsWithHeader(text: string): boolean {
  const first = text.split(/\r?\n/).find((l) => l.trim() !== '');
  if (!first) return false;
  return DELIMITERS.some((d) => {
    try {
      const cells = parse(first, { delimiter: d, relax_quotes: true, relax_column_count: true })[0] as string[] | undefined;
      return cells !== undefined && readHeader(cells) !== null;
    } catch {
      return false;
    }
  });
}

/** One person per line. */
function parseLines(raw: string, source: LeadSource): ParseResult {
  const text = stripBom(raw);
  const out = new Collector(source);
  text.split(/\r?\n/).forEach((line, i) => {
    if (line.trim() === '') return;
    const row = i + 1;
    const many = emailsOnly(line);
    if (many) {
      for (const email of many) out.add({ name: null, first: null, email: cleanEmail(email), company: null, role: null, linkedinUrl: null, xHandle: null, timezone: null }, row);
      return;
    }
    out.add(parsePasteLine(line), row);
  });
  return out.result();
}

/** Names and handles pasted from anywhere: a few lines, a spreadsheet selection, or a CSV with a header row. */
export function parsePaste(raw: string): ParseResult {
  const text = stripBom(raw);
  return startsWithHeader(text) ? readTable(text, 'paste') : parseLines(text, 'paste');
}
