import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { decodeLeadFile, ImportFileError, parseCsv, parsePaste } from './parse.js';

const fixture = (name: string) => readFileSync(new URL(`./__fixtures__/${name}`, import.meta.url), 'utf8');

/** Encode text as Windows-1252, the way Excel saves a CSV on a Windows machine. */
function toWindows1252(s: string): Uint8Array {
  const special: Record<string, number> = { '’': 0x92, '‘': 0x91, '–': 0x96, '—': 0x97, '€': 0x80, '“': 0x93, '”': 0x94 };
  return Uint8Array.from([...s].map((ch) => {
    const code = ch.codePointAt(0)!;
    if (special[ch] !== undefined) return special[ch];
    if (code > 0xff) throw new Error(`not in windows-1252: ${ch}`);
    return code;
  }));
}

function toUtf16le(s: string, bom = true): Uint8Array {
  const body = Buffer.from(s, 'utf16le');
  return bom ? Buffer.concat([Buffer.from([0xff, 0xfe]), body]) : body;
}

describe('parseCsv: the messy-list case from the review', () => {
  const messy =
    '﻿First Name;Last Name;Work Email;Company;LinkedIn\r\n' +
    'Kemi;Eze;kemi@okopay.com;Oko Pay;\r\n' +
    ';;;;\r\n' +
    'Femi;Ade;;Ledgerly;linkedin.com/in/femi-ade\r\n' +
    'Kemi;Eze;KEMI@okopay.com;Oko Pay;\r\n' +
    'Tunde;Bakare;;Paystack Partners;\r\n';

  it('imports the good rows and reports each skipped row with its reason', () => {
    const { people, skipped } = parseCsv(messy);
    expect(people).toEqual([
      { name: 'Kemi Eze', firstName: 'Kemi', email: 'kemi@okopay.com', company: 'Oko Pay', source: 'csv' },
      { name: 'Femi Ade', firstName: 'Femi', linkedinUrl: 'https://www.linkedin.com/in/femi-ade', company: 'Ledgerly', source: 'csv' },
    ]);
    expect(skipped).toEqual([
      { name: 'Kemi Eze', reason: 'duplicate', row: 5 },
      { name: 'Tunde Bakare', reason: 'no_channel', row: 6 },
    ]);
  });
});

describe('parseCsv: real exports', () => {
  it('LinkedIn Connections.csv: notes lines before the header, "URL" and "Position" columns, a blank row', () => {
    const { people, skipped } = parseCsv(fixture('linkedin-connections.csv'));
    expect(people).toEqual([
      { name: 'Kemi Eze', firstName: 'Kemi', company: 'Oko Pay', role: 'Head of Finance Operations', linkedinUrl: 'https://www.linkedin.com/in/kemi-eze-5a2b1c', source: 'csv' },
      { name: 'Femi Ade', firstName: 'Femi', company: 'Ledgerly', role: 'VP, Engineering', email: 'femi.ade@ledgerly.io', linkedinUrl: 'https://www.linkedin.com/in/femi-ade', source: 'csv' },
      { name: 'Zoë Müller', firstName: 'Zoë', company: 'Rivers, Hill & Co', role: 'Founder & CEO', linkedinUrl: 'https://www.linkedin.com/in/zoe-muller-77', source: 'csv' },
      { name: 'Ada Okafor', firstName: 'Ada', role: undefined, email: 'ada@okafor.dev', linkedinUrl: 'https://www.linkedin.com/in/ada-okafor', source: 'csv' },
    ]);
    expect(skipped).toEqual([{ name: 'Tunde Bakare', reason: 'no_channel', row: 8 }]);
  });

  it('LinkedIn Connections.csv saved with Windows line endings and a UTF-8 BOM reads the same', () => {
    const asSaved = Buffer.from('\uFEFF' + fixture('linkedin-connections.csv').replace(/\n/g, '\r\n'), 'utf8');
    expect(parseCsv(decodeLeadFile(asSaved))).toEqual(parseCsv(fixture('linkedin-connections.csv')));
    expect(parseCsv(decodeLeadFile(asSaved)).people).toHaveLength(4);
  });

  it('Apollo export: person LinkedIn, not the company page; locked emails dropped; "Company" not "Company Name for Emails"', () => {
    const { people, skipped } = parseCsv(fixture('apollo-export.csv'));
    expect(people).toEqual([
      { name: 'Kemi Eze', firstName: 'Kemi', role: 'Head of Finance Operations', company: 'Oko Pay', email: 'kemi@okopay.com', linkedinUrl: 'https://www.linkedin.com/in/kemi-eze-5a2b1c', source: 'csv' },
      { name: 'Femi Ade', firstName: 'Femi', role: 'VP Engineering', company: 'Ledgerly', linkedinUrl: 'https://www.linkedin.com/in/femi-ade', source: 'csv' },
      { name: 'Amaka Obi', firstName: 'Amaka', role: 'CFO', company: 'Northgate, Ltd', email: 'amaka@northgate.example', linkedinUrl: 'https://www.linkedin.com/in/amaka-obi', source: 'csv' },
    ]);
    expect(skipped).toEqual([{ name: 'Sade Bello', reason: 'no_channel', row: 4 }]);
  });

  it('HubSpot contacts export: job title, associated company, time zone, Twitter username', () => {
    const { people, skipped } = parseCsv(fixture('hubspot-contacts.csv'));
    expect(people).toEqual([
      { name: 'Kemi Eze', firstName: 'Kemi', role: 'Head of Finance Operations', company: 'Oko Pay', email: 'kemi@okopay.com', xHandle: 'kemieze', timezone: 'Africa/Lagos', source: 'csv' },
      { name: 'Tomás Rivera', firstName: 'Tomás', role: 'Owner', company: 'Rivera Print, S.L.', email: 'tomas@riveraprint.example', timezone: 'Europe/Madrid', source: 'csv' },
      // An unknown time zone is left out, so the person keeps the user's own time zone.
      { name: 'Priya Nair', firstName: 'Priya', role: 'CTO', company: 'Helix', email: 'priya.nair@helix.example', xHandle: 'priyanair', source: 'csv' },
    ]);
    expect(skipped).toEqual([{ name: 'Nobody', reason: 'no_channel', row: 4 }]);
  });

  it('Google Contacts export: several emails in one cell, e-mail 2, a LinkedIn profile kept as a website, a note with a line break', () => {
    const { people, skipped } = parseCsv(fixture('google-contacts.csv'));
    expect(people).toEqual([
      { name: 'Kemi Eze', firstName: 'Kemi', role: 'Head of Finance', company: 'Oko Pay', email: 'kemi@okopay.com', source: 'csv' },
      { name: 'Femi Ade', firstName: 'Femi', role: 'VP Engineering', company: 'Ledgerly', email: 'femi.ade@ledgerly.io', linkedinUrl: 'https://www.linkedin.com/in/femi-ade', source: 'csv' },
      // No name at all: the email's local part stands in.
      { name: 'sade', company: 'Brightwell', email: 'sade@brightwell.co', source: 'csv' },
    ]);
    expect(skipped).toEqual([{ name: 'Mum', reason: 'no_channel', row: 6 }]);
  });
});

describe('parseCsv: encodings and separators', () => {
  const sheet =
    'First Name;Last Name;Work Email;Company;Title\r\n' +
    'Zoë;Müller;zoe@mueller.example;Müller & Söhne;Geschäftsführer\r\n' +
    'Siobhán;O’Brien;siobhan@obrien.example;O’Brien – Legal;Partner\r\n';

  it('reads an Excel CSV saved as Windows-1252', () => {
    const { people } = parseCsv(decodeLeadFile(toWindows1252(sheet)));
    expect(people.map((p) => [p.name, p.company, p.role])).toEqual([
      ['Zoë Müller', 'Müller & Söhne', 'Geschäftsführer'],
      ['Siobhán O’Brien', 'O’Brien – Legal', 'Partner'],
    ]);
  });

  it('reads an Excel "Unicode text" file: UTF-16 with a BOM, tab separated, quoted cells', () => {
    const text = 'Full Name\tE-mail\tOrganization\tJob Title\r\n"Kemi Eze"\tkemi@okopay.com\t"Oko Pay, Lagos"\tHead of Finance\r\n';
    const { people } = parseCsv(decodeLeadFile(toUtf16le(text)));
    expect(people).toEqual([
      { name: 'Kemi Eze', company: 'Oko Pay, Lagos', role: 'Head of Finance', email: 'kemi@okopay.com', source: 'csv' },
    ]);
  });

  it('reads UTF-16 without a BOM, and UTF-8 with one', () => {
    const csv = 'Name,Email\nKemi Eze,kemi@okopay.com\n';
    expect(parseCsv(decodeLeadFile(toUtf16le(csv, false))).people).toHaveLength(1);
    expect(parseCsv(decodeLeadFile(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(csv)]))).people).toHaveLength(1);
    expect(parseCsv(decodeLeadFile(Buffer.from('Name,Email\nZoë,zoe@x.example\n', 'utf8'))).people[0]?.name).toBe('Zoë');
  });

  it('still strips a BOM from text that was already decoded', () => {
    expect(parseCsv('﻿Name,Email\nKemi Eze,kemi@okopay.com\n').people).toHaveLength(1);
    expect(parseCsv('ï»¿Name,Email\nKemi Eze,kemi@okopay.com\n').people).toHaveLength(1);
  });

  it('reads a TSV', () => {
    const tsv = 'Name\tEmail\tCompany\tTitle\nKemi Eze\tkemi@okopay.com\tOko Pay, Lagos\tHead of Finance, Ops\nFemi Ade\tfemi@ledgerly.io\tLedgerly\t\n';
    const { people } = parseCsv(tsv);
    expect(people.map((p) => [p.name, p.company, p.role])).toEqual([
      ['Kemi Eze', 'Oko Pay, Lagos', 'Head of Finance, Ops'],
      ['Femi Ade', 'Ledgerly', undefined],
    ]);
  });

  it('keeps quoted fields with embedded commas and quotes, and turns line breaks inside a cell into spaces', () => {
    const csv =
      'Name,Email,Company,Title\n' +
      '"Eze, Kemi",kemi@okopay.com,"Oko ""Pay"" Ltd","Head of Finance\nand Operations"\n' +
      'Femi Ade,femi@ledgerly.io,Ledgerly,CTO\n';
    const { people, skipped } = parseCsv(csv);
    expect(people.map((p) => [p.name, p.company, p.role])).toEqual([
      ['Eze, Kemi', 'Oko "Pay" Ltd', 'Head of Finance and Operations'],
      ['Femi Ade', 'Ledgerly', 'CTO'],
    ]);
    expect(skipped).toEqual([]);
  });

  it('picks the separator that makes the header make sense', () => {
    // Commas inside the cells must not win over the real semicolon separator.
    const csv = 'Name;Email;Company\nEze, Kemi;kemi@okopay.com;Oko Pay, Lagos, Nigeria\n';
    expect(parseCsv(csv).people[0]).toMatchObject({ name: 'Eze, Kemi', company: 'Oko Pay, Lagos, Nigeria' });
  });
});

describe('parseCsv: headers', () => {
  it('knows the aliases, in any case and spelling', () => {
    const csv =
      'FULL NAME,e-mail,Account,Headline,Profile,Twitter,Time Zone\n' +
      'Kemi Eze,kemi@okopay.com,Oko Pay,Head of Finance,https://www.linkedin.com/in/kemi-eze,@kemieze,Africa/Lagos\n';
    expect(parseCsv(csv).people).toEqual([{
      name: 'Kemi Eze', email: 'kemi@okopay.com', company: 'Oko Pay', role: 'Head of Finance',
      linkedinUrl: 'https://www.linkedin.com/in/kemi-eze', xHandle: 'kemieze', timezone: 'Africa/Lagos', source: 'csv',
    }]);
  });

  it('joins first and last name, and falls back across the other aliases', () => {
    const csv = 'first name,last name,work email,organization,role,linkedin url,x handle,timezone\nKemi,Eze,k@okopay.com,Oko Pay,CFO,linkedin.com/in/kemi,kemi_e,Europe/London\n';
    expect(parseCsv(csv).people[0]).toMatchObject({
      name: 'Kemi Eze', firstName: 'Kemi', email: 'k@okopay.com', company: 'Oko Pay', role: 'CFO',
      linkedinUrl: 'https://www.linkedin.com/in/kemi', xHandle: 'kemi_e', timezone: 'Europe/London',
    });
  });

  it('uses only a first name column when there is no last name', () => {
    expect(parseCsv('First Name,Email\nKemi,kemi@okopay.com\n').people[0]).toMatchObject({ name: 'Kemi', firstName: 'Kemi' });
  });

  it('ignores note lines and blank lines above the header, wherever the header is', () => {
    const csv = 'Exported by Some CRM\nGenerated on 2 Nov 2026, 10:12\n\n\nName,Email\nKemi Eze,kemi@okopay.com\n';
    const { people } = parseCsv(csv);
    expect(people).toHaveLength(1);
    expect(people[0]?.name).toBe('Kemi Eze');
  });

  it('uses the email local part when a row has no name, and a LinkedIn slug when it has neither', () => {
    const csv = 'Name,Email,LinkedIn\n,kemi.eze@okopay.com,\n,,https://www.linkedin.com/in/femi-ade-3a1b2c4\n';
    expect(parseCsv(csv).people.map((p) => p.name)).toEqual(['kemi.eze', 'Femi Ade']);
  });

  it('names a LinkedIn-only row from its slug even when the slug has odd percent escapes', () => {
    const csv = 'Name,LinkedIn\n,https://www.linkedin.com/in/jos%C3%A9-ruiz\n,https://www.linkedin.com/in/jos%e9-ruiz\n,https://www.linkedin.com/in/100%25\n';
    expect(parseCsv(csv).people.map((p) => p.name)).toEqual(['José Ruiz', 'Jos%e9 Ruiz', '100%']);
  });

  it('treats placeholders as empty and rejects text that is not an email', () => {
    const csv = 'Name,Email,Company,Title,LinkedIn\nKemi Eze,n/a,--,N/A,not a url\nFemi Ade,"femi at ledgerly",,,\nAda,"Ada <ada@okafor.dev>",,,\n';
    const { people, skipped } = parseCsv(csv);
    expect(people).toEqual([{ name: 'Ada', email: 'ada@okafor.dev', source: 'csv' }]);
    expect(skipped.map((s) => [s.name, s.reason])).toEqual([['Kemi Eze', 'no_channel'], ['Femi Ade', 'no_channel']]);
  });

  it('reports duplicates inside the file by any shared handle', () => {
    const csv =
      'Name,Email,LinkedIn\n' +
      'Kemi Eze,kemi@okopay.com,\n' +
      'K. Eze,,https://www.linkedin.com/in/kemi-eze\n' +
      'Kemi E,KEMI@OKOPAY.COM,\n' +
      'Kemi Eze again,,linkedin.com/in/kemi-eze/\n';
    const { people, skipped } = parseCsv(csv);
    expect(people.map((p) => p.name)).toEqual(['Kemi Eze', 'K. Eze']);
    expect(skipped).toEqual([
      { name: 'Kemi E', reason: 'duplicate', row: 4 },
      { name: 'Kemi Eze again', reason: 'duplicate', row: 5 },
    ]);
  });

  it('gives an empty result for an empty file or a header with no rows', () => {
    expect(parseCsv('')).toEqual({ people: [], skipped: [] });
    expect(parseCsv('  \n\n')).toEqual({ people: [], skipped: [] });
    expect(parseCsv('Name,Email\n')).toEqual({ people: [], skipped: [] });
  });

  it('says plainly when there is no header, and when a quote is never closed', () => {
    expect(() => parseCsv('Kemi Eze,kemi@okopay.com,Oko Pay\nFemi Ade,femi@ledgerly.io,Ledgerly\n')).toThrow(ImportFileError);
    expect(() => parseCsv('Kemi Eze,kemi@okopay.com,Oko Pay\n')).toThrow(/column for names, emails or LinkedIn/);
    expect(() => parseCsv('Name,Email\n"Kemi Eze,kemi@okopay.com\nFemi Ade,femi@ledgerly.io\n')).toThrow(/quote.*line 2/i);
  });

  it('copes with rows that are shorter or longer than the header', () => {
    const csv = 'Name,Email,Company\nKemi Eze,kemi@okopay.com\nFemi Ade,femi@ledgerly.io,Ledgerly,extra,cells\n';
    const { people } = parseCsv(csv);
    expect(people.map((p) => [p.email, p.company])).toEqual([['kemi@okopay.com', undefined], ['femi@ledgerly.io', 'Ledgerly']]);
  });

  it('handles a big file', () => {
    const rows = Array.from({ length: 20000 }, (_, i) => `Person ${i},p${i}@bulk.example,Company ${i % 50}`);
    const { people, skipped } = parseCsv(['Name,Email,Company', ...rows].join('\r\n'));
    expect(people).toHaveLength(20000);
    expect(skipped).toEqual([]);
  });
});

describe('parsePaste', () => {
  it('reads names, emails, companies and LinkedIn links by shape', () => {
    const { people, skipped } = parsePaste('Kemi Eze, kemi@okopay.com, Oko Pay\nhttps://linkedin.com/in/femi-ade Femi Ade');
    expect(people).toEqual([
      { name: 'Kemi Eze', email: 'kemi@okopay.com', company: 'Oko Pay', source: 'paste' },
      { name: 'Femi Ade', linkedinUrl: 'https://www.linkedin.com/in/femi-ade', source: 'paste' },
    ]);
    expect(skipped).toEqual([]);
  });

  it('accepts the pieces in any order, tabs from a spreadsheet, and Windows line endings', () => {
    const text = 'kemi@okopay.com\tKemi Eze\tOko Pay\r\n\r\nFemi Ade, @femiade, Ledgerly\r\nada@okafor.dev\r\n';
    const { people } = parsePaste(text);
    expect(people).toEqual([
      { name: 'Kemi Eze', email: 'kemi@okopay.com', company: 'Oko Pay', source: 'paste' },
      { name: 'Femi Ade', xHandle: 'femiade', company: 'Ledgerly', source: 'paste' },
      { name: 'ada', email: 'ada@okafor.dev', source: 'paste' },
    ]);
  });

  it('reads "Name <email>" and bare lines with only spaces', () => {
    const { people } = parsePaste('Kemi Eze <kemi@okopay.com>\nFemi Ade femi@ledgerly.io\nhttps://x.com/adaokafor Ada Okafor');
    expect(people).toEqual([
      { name: 'Kemi Eze', email: 'kemi@okopay.com', source: 'paste' },
      { name: 'Femi Ade', email: 'femi@ledgerly.io', source: 'paste' },
      { name: 'Ada Okafor', xHandle: 'adaokafor', source: 'paste' },
    ]);
  });

  it('takes a line of nothing but emails as several people', () => {
    const { people } = parsePaste('kemi@okopay.com, femi@ledgerly.io; ada@okafor.dev');
    expect(people.map((p) => p.email)).toEqual(['kemi@okopay.com', 'femi@ledgerly.io', 'ada@okafor.dev']);
  });

  it('reports a line with no way to reach the person, and a repeat', () => {
    const { people, skipped } = parsePaste('Tunde Bakare, Paystack Partners\nKemi Eze, kemi@okopay.com\nkemi@okopay.com');
    expect(people.map((p) => p.name)).toEqual(['Kemi Eze']);
    expect(skipped).toEqual([
      { name: 'Tunde Bakare', reason: 'no_channel', row: 1 },
      { name: 'kemi', reason: 'duplicate', row: 3 },
    ]);
  });

  it('hands text with a header row to the CSV reader, keeping the paste source', () => {
    const { people } = parsePaste('Name\tEmail\tCompany\nKemi Eze\tkemi@okopay.com\tOko Pay\nFemi Ade\tfemi@ledgerly.io\tLedgerly\n');
    expect(people).toEqual([
      { name: 'Kemi Eze', email: 'kemi@okopay.com', company: 'Oko Pay', source: 'paste' },
      { name: 'Femi Ade', email: 'femi@ledgerly.io', company: 'Ledgerly', source: 'paste' },
    ]);
  });

  it('returns nothing for an empty paste', () => {
    expect(parsePaste('  \n \n')).toEqual({ people: [], skipped: [] });
  });
});
