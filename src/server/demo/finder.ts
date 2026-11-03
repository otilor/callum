import type { PersonLead } from '../../shared/types.js';
import type { FindQuery, PeopleFinder } from '../leads/finder.js';

const FIRST = ['Adaeze', 'Kwame', 'Zainab', 'Tobi', 'Efua', 'Chidi', 'Amara', 'Yaw', 'Ngozi', 'Kofi', 'Halima', 'Seun', 'Akosua', 'Emeka', 'Fatima', 'Kojo'];
const LAST = ['Nwosu', 'Asante', 'Bello', 'Adeyemi', 'Mensah', 'Okafor', 'Diallo', 'Boateng', 'Eze', 'Owusu', 'Sani', 'Lawal', 'Darko', 'Obi', 'Yeboah', 'Ige'];
const COMPANIES = ['Ledgerline', 'Tilde Pay', 'Kora Labs', 'Moni Works', 'Harbor Pay', 'Ikeja Cloud', 'Volta Ledger', 'Savanna Books'];

const slug = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]/g, '');

/**
 * The demo's people search: made-up people on reserved `.example` addresses, so trying Callum never reaches anyone
 * or spends anything. The role comes from the words the user typed.
 */
export class DemoFinder implements PeopleFinder {
  private next = 0;

  async find(q: FindQuery): Promise<PersonLead[]> {
    const role = q.description.trim().replace(/\s+(in|at|near|around)\s+.*$/i, '').replace(/s$/i, '') || 'Founder';
    const people: PersonLead[] = [];
    const known = new Set((q.known ?? []).map((k) => k.replace(/\s*\(.*\)$/, '').toLowerCase()));
    const want = Math.max(1, Math.min(50, q.count));
    // 16 first names by 16 last names: 256 different people before any name comes round again.
    for (let tries = 0; people.length < want && tries < 256; tries++) {
      const n = this.next++ % 256;
      const first = FIRST[n % FIRST.length] as string;
      const last = LAST[(n + Math.floor(n / FIRST.length)) % LAST.length] as string;
      if (known.has(`${first} ${last}`.toLowerCase())) continue;
      const company = COMPANIES[n % COMPANIES.length] as string;
      const person: PersonLead = {
        name: `${first} ${last}`, firstName: first, role: role.charAt(0).toUpperCase() + role.slice(1), company,
        source: 'web', note: `A made-up person for the demo. Found on ${slug(company)}.example.`,
      };
      if (n % 3 === 2) person.xHandle = `${slug(first)}${slug(last)}`.slice(0, 15);
      else person.linkedinUrl = `https://www.linkedin.com/in/${slug(first)}-${slug(last)}-demo`;
      if (n % 2 === 0) person.email = `${slug(first)}@${slug(company)}.example`;
      people.push(person);
    }
    return people;
  }
}
