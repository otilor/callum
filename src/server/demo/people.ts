import type { Channel } from '../../shared/types.js';

/** A person in the demo, with everything a lead source would have found. */
export interface DemoPerson {
  name: string;
  firstName: string;
  role: string;
  company: string;
  channel: Channel;
  email: string | null;
  linkedinUrl: string | null;
  xHandle: string | null;
  timezone: string;
}

type Row = readonly [first: string, last: string, role: string, company: string, channel: Channel, timezone?: string];

const LAGOS = 'Africa/Lagos';
const ACCRA = 'Africa/Accra';

const letters = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]/g, '');

/**
 * Every address sits on a reserved `.example` domain, so nothing in the demo can reach a real inbox.
 * People reached on LinkedIn or X carry only that handle; some people reached by email also have a LinkedIn page.
 */
function build(rows: readonly Row[], timezone: string, withLinkedinEvery: number): DemoPerson[] {
  return rows.map(([first, last, role, company, channel, zone], i) => {
    const slug = `${letters(first)}-${letters(last)}`;
    return {
      name: `${first} ${last}`,
      firstName: first,
      role,
      company,
      channel,
      email: channel === 'email' ? `${letters(first)}@${letters(company)}.example` : null,
      linkedinUrl: channel === 'linkedin' || (channel === 'email' && i % withLinkedinEvery === 0)
        ? `https://www.linkedin.com/in/${slug}`
        : null,
      xHandle: channel === 'x' ? `${letters(first)}${letters(last)}`.slice(0, 15) : null,
      timezone: zone ?? timezone,
    };
  });
}

/**
 * The 40 people of the Reconciliation project: fintech founders and finance leads in Lagos, as on the boards.
 * The order matters: the morning scene gives each position a place in the river.
 */
export const DEMO_PEOPLE: readonly DemoPerson[] = build([
  ['Kemi', 'Eze', 'Founder', 'Oko Pay', 'email'], ['Tunde', 'Bello', 'CEO', 'Ireti Labs', 'email'], ['Ada', 'Nwosu', 'Co-founder', 'Yaba Ledger', 'linkedin'],
  ['Femi', 'Adeyemi', 'Founder', 'Eko Wallet', 'email'], ['Zainab', 'Musa', 'CEO', 'Lagoon Pay', 'email'], ['Chidi', 'Okeke', 'Co-founder', 'Marina Ledger', 'linkedin'],
  ['Bisi', 'Alade', 'Founder', 'Ikoyi Pay', 'email'], ['Emeka', 'Obi', 'CEO', 'Surulere Labs', 'email'], ['Ngozi', 'Ibe', 'COO', 'Bariga Pay', 'linkedin'],
  ['Seun', 'Ojo', 'Founder', 'Lekki Ledger', 'email'], ['Tolu', 'Adebayo', 'Founder', 'Ajah Money', 'email'], ['Ifeoma', 'Okonkwo', 'CEO', 'Ebute Pay', 'linkedin'],
  ['Yusuf', 'Danjuma', 'Co-founder', 'Island Books', 'email'], ['Funke', 'Bakare', 'Head of Finance', 'Ojo Credit', 'email'], ['Dayo', 'Ogunleye', 'Founder', 'Mainland Pay', 'x'],
  ['Amaka', 'Nwankwo', 'CEO', 'Ilupeju Labs', 'email'], ['Kunle', 'Lawal', 'Founder', 'Obalende Pay', 'linkedin'], ['Halima', 'Sani', 'COO', 'Gbagada Finance', 'email'],
  ['Obinna', 'Uzor', 'Co-founder', 'Festac Wallet', 'email'], ['Sade', 'Afolabi', 'Founder', 'Apapa Ledger', 'x'], ['Ibrahim', 'Balogun', 'CEO', 'Agege Pay', 'email'],
  ['Nneka', 'Okafor', 'Head of Finance', 'Ikeja Books', 'linkedin'], ['Wale', 'Oyelaran', 'Founder', 'Maryland Pay', 'email'], ['Chioma', 'Chukwu', 'CEO', 'Ogba Labs', 'email'],
  ['Musa', 'Ajayi', 'Founder', 'Onikan Money', 'email'], ['Folake', 'Idowu', 'CFO', 'Ketu Pay', 'linkedin'], ['Uche', 'Onyeka', 'Co-founder', 'Ojota Ledger', 'email'],
  ['Aisha', 'Mohammed', 'CEO', 'Badagry Labs', 'email'], ['Bayo', 'Fashola', 'Founder', 'Epe Wallet', 'x'], ['Efe', 'Omoregie', 'Founder', 'Idumota Pay', 'email'],
  ['Lola', 'Adeyinka', 'Head of Finance', 'Oshodi Books', 'linkedin'], ['Gbenga', 'Oladipo', 'CEO', 'Alaba Credit', 'email'], ['Hauwa', 'Garba', 'COO', 'Magodo Pay', 'email'],
  ['Ike', 'Nnaji', 'Co-founder', 'Ikota Labs', 'email'], ['Temi', 'Coker', 'Founder', 'Sangotedo Pay', 'linkedin'], ['Segun', 'Ademola', 'CEO', 'Ogudu Ledger', 'email'],
  ['Adaeze', 'Eke', 'Founder', 'Akoka Wallet', 'x'], ['Kola', 'Bankole', 'Founder', 'Ijora Pay', 'email'], ['Ronke', 'Alabi', 'CFO', 'Mushin Labs', 'email'],
  ['Nnamdi', 'Okoro', 'CEO', 'Isolo Finance', 'linkedin'],
], LAGOS, 3);

/** The ten people of the Payroll project: growing teams in Lagos and Accra. Yaw is the one who replied. */
export const PAYROLL_PEOPLE: readonly DemoPerson[] = [
  ...build([
    ['Yaw', 'Mensah', 'Head of People', 'Kumasi Foods', 'email'], ['Efua', 'Owusu', 'HR Manager', 'Osu Health', 'email'],
    ['Kwame', 'Boakye', 'Finance Manager', 'Tema Logistics', 'email'], ['Halima', 'Bello', 'Head of People', 'Abuja Freight', 'email', LAGOS],
  ], ACCRA, 2),
  ...build([
    ['Dayo', 'Adewale', 'Founder', 'Yaba Studio', 'x'], ['Ama', 'Serwaa', 'COO', 'Cantonments Retail', 'linkedin', ACCRA],
    ['Kofi', 'Adjei', 'Head of People', 'Takoradi Marine', 'email', ACCRA], ['Ifeoma', 'Eze', 'HR Manager', 'Lekki Foods', 'linkedin'],
    ['Musa', 'Garba', 'Finance Manager', 'Ikeja Textiles', 'email'], ['Bukola', 'Adeniyi', 'Founder', 'Surulere Bakes', 'email'],
  ], LAGOS, 2),
];
