import { describe, expect, it } from 'vitest';
import type { ReplyKind } from '../../shared/types.js';
import { fixedClock } from '../engine/clock.js';
import { testCtx, outbound } from './testing.test-helpers.js';
import { TemplateWriter, isExplicitOptOut } from './templates.js';

/**
 * Regression corpus for the template classifier. Every row is a real-looking reply.
 *
 * The guiding rule: a false "interested" costs the user one glance at the dock; a false stop, hostile or
 * out-of-office silently loses a person. So rows that are not clearly one of those three assert "not lost".
 *
 * expected: a kind, a list of acceptable kinds, '!lost' (anything but stop / hostile / out_of_office),
 * or '!kind' (anything but that kind).
 */
type Expected = ReplyKind | ReplyKind[] | '!lost' | `!${ReplyKind}`;
type Row = [text: string, expected: Expected];

const LOST: ReplyKind[] = ['stop', 'hostile', 'out_of_office'];
const sig = '\n\nBest,\nKemi Eze\nHead of Finance | Oko Pay\nkemi@okopay.com | +234 803 555 0100';
const quoted = "\n\nOn Mon, 2 Nov 2026 at 09:00, Ada Obi <ada@example.com> wrote:\n> Hi Kemi, I help fintech teams...\n> If this isn't for you, just reply stop and I won't write again.";

const rows: Record<string, Row[]> = {
  'true opt-outs': [
    ['Please remove me from your list', 'stop'], ['unsubscribe', 'stop'], ['Stop', 'stop'], ['STOP emailing me', 'stop'],
    ['Stop.' + sig, 'stop'], ['STOP' + quoted, 'stop'], ['pls remove me' + quoted, 'stop'],
    ['Please stop contacting me.', 'stop'], ['Do not email me again.', 'stop'], ['Kindly take me off your mailing list. Thanks', 'stop'],
    ['stop', 'stop'], ['Stop!!!', 'stop'], ['STOP. Not interested.', 'stop'], ['Stop. Not interested.', 'stop'], ['Stop, not interested.', 'stop'],
    ['STOP - not interested\n\nSent from my iPhone', 'stop'],
    ['stop.', 'stop'], ['"Stop"', 'stop'], ['Please stop', 'stop'], ['STOP STOP STOP', 'stop'], ['Stop now.', 'stop'], ['I said stop.', 'stop'],
    ['Please stop, thanks.', 'stop'], ['Just stop.', 'stop'], ['Stop please.\n\nKemi', 'stop'], ['Stop pls\n\nGet Outlook for Android', 'stop'],
    ['STOP\n\nSent from my iPhone', 'stop'], ['Stop.\n--\nKemi', 'stop'], ['Stop thanks\n\nSent from my iPhone', 'stop'], ['stop\n\nKemi Eze\nCFO', 'stop'],
    ['Please stop.\n\nThanks,\nKemi Eze\nCFO, Oko Pay\n+234 803 555 0100', 'stop'], ['Kindly stop.\n\nBest,\nKemi', 'stop'],
    ['Kindly stop emailing me.\n\nBest,\nKemi', 'stop'], ['Please, stop.', 'stop'], ['Stop, please.', 'stop'], ['STOP!!\n\nSent from my Samsung Galaxy smartphone.', 'stop'],
    ['Stop.\n\n________________________________\nFrom: Ada Obi <ada@example.com>\nSent: Monday\nSubject: Quick question', 'stop'],
    ['No thanks. Stop.', 'stop'], ['Stop sending me this.', 'stop'], ['Stop emailing, please', 'stop'],
    ['Unsubscribe', 'stop'], ['Remove me from your list', 'stop'], ["Don't email me again", 'stop'], ['Please opt me out', 'stop'], ['take me off', 'stop'],
    ['Never email me again', 'stop'], ['Do not contact us anymore.', 'stop'], ["Don't write to me", 'stop'], ['opt out of these emails', 'stop'],
    ['Kindly unsubscribe me.', 'stop'], ['Kindly remove me.', 'stop'], ['Never contact me or my team again.', 'stop'], ['Do not contact us again, ever.', 'stop'],
    ['stop sending me this rubbish', 'stop'],
    ['Do not email me at this address again.', 'stop'], ['Please do not contact me at all.', 'stop'], ["Don't email me with this stuff again.", 'stop'],
    ['Please do not contact me at all.\n\nKemi', 'stop'], ["Please don't email again.", 'stop'], ["Please don't send me any more emails.", 'stop'],
    ['Remove my email from your list please.', 'stop'], ['No more emails please.', 'stop'], ['Opt out.', 'stop'], ["I'd like to opt out.", 'stop'],
    ['Please remove me from your list.\n\nKind regards,\nKemi Eze\nCFO, Oko Pay', 'stop'],
    ['Not interested. Please do not contact me again.', 'stop'],
  ],
  'opt-outs after a greeting and a thank-you (must not be eaten as a sign-off)': [
    ['Hi Ada,\n\nThank you.\nI am not interested, please remove me from your mailing list.\n\nRegards,\nKemi', 'stop'],
    ['Hi Ada,\nThanks!\nPlease take me off your list.\nKemi', 'stop'],
    ['Ada,\n\nThank you.\n\nSTOP.', 'stop'],
    ['Hello,\nThanks.\nUnsubscribe.', 'stop'],
    ['Thanks for this.\n\nCheers,\nKemi\n\nPS: please don\'t email me again.', 'stop'],
    ['Dear Ada,\n\nThank you.\nPlease do not contact me again.\n\nKind regards,\nKemi Eze\nCFO, Oko Pay', 'stop'],
    ['Hi Ada,\n\nThank you for reaching out.\nPlease remove me from your list.\n\nRegards,\nKemi', 'stop'],
    ['Hi Ada,\n\nThank you.\nWe are not interested.\n\nRegards,\nKemi', 'not_interested'],
    ['Hi Ada,\n\nThanks!\nThis is spam, f*** off.\n\nKemi', 'hostile'],
    ['Hi,\nRegards,\nthis is spam, f*** off', 'hostile'],
    ['Hola Ada,\n\nGracias.\nPor favor, darse de baja.\n\nSaludos,\nKemi', 'stop'],
    ["Good morning,\n\nThank you.\nI'm out of the office until 20 November with no access to email.", 'out_of_office'],
    ['Hi Ada\nThanks\nYes interested, call me Friday on 0803 555 0100', '!lost'],
  ],
  'opt-outs in other languages': [
    ['Merci de me désabonner.\n\nCordialement,\nKemi', 'stop'], ['Por favor, denme de baja.\n\nSaludos', 'stop'],
    ['Quiero darme de baja.', 'stop'], ['Dame de baja, por favor.', 'stop'], ['Quiero darme de baja', 'stop'], ['Dame de baja', 'stop'],
    ['Por favor, no me envíen más correos.', 'stop'], ['Merci de ne plus me contacter.', 'stop'], ['Merci de ne plus me contacter', 'stop'],
    ['Veuillez me retirer de votre liste.', 'stop'], ['Bitte keine E-Mails mehr.', 'stop'], ['Bitte keine E-Mails mehr', 'stop'],
    ['Bitte streichen Sie mich von Ihrer Liste.', 'stop'], ['Bitte nehmen Sie mich aus dem Verteiler.\n\nMit freundlichen Grüßen\nKemi', 'stop'],
    ['Por favor, não me envie mais e-mails.', 'stop'], ['Por favor, não me envie mais e-mails', 'stop'], ['Quero me descadastrar.', 'stop'],
    ['Por favor, me remova da lista.', 'stop'],
    ['Je voudrais me désabonner.', 'stop'], ['Quiero darse de baja de esta lista.', 'stop'], ['Bitte abmelden.', 'stop'], ['Pode me descadastrar?', 'stop'],
  ],
  'an opt-out phrase that is not an opt-out': [
    ["I don't email much, WhatsApp me on 0803 555 0100 and let's talk.", '!lost'],
    ['Can we opt out of the annual plan and pay monthly?', '!lost'],
    ['We do not write our own recon scripts, so yes, interested.', '!lost'],
    ["Don't contact sales, contact me directly. When are you free?", '!lost'],
    ["Don't email me at 9am, email me at kemi@okopay.com instead.", 'not_interested'],
    ["Please don't email me here, WhatsApp me on 0803 555 0100.", '!lost'],
    ["Don't send me the PDF, just call me on Thursday.", '!lost'],
    ["We've been non-stop since launch. Can we talk next month?", '!lost'],
    ["We're a one-stop shop, how is this different?", '!lost'],
    ['We are a nonstop operation right now. Interested though.', '!lost'],
    ["Please don't stop, keen to hear more.", '!lost'],
    ["I can't stop thinking about the reconciliation problem. Tell me more.", '!lost'],
    ["Full stop, we're happy with our current setup.", 'not_interested'],
    ['Stop by our office on Thursday?', '!lost'], ['stop by our booth at Afritech, stand 42', '!lost'], ['pls stop by our booth at Afritech, stand 42', '!lost'],
    ["Stop me if you've heard this one: we built this in-house last year.", '!lost'],
    ["we've stopped using spreadsheets for this already, so prob not a fit", '!lost'],
    ['Bus stop chat at the conference was fun, lets continue. Free Fri?', '!lost'],
    ["Can't stop laughing at the timing, we literally just hired for this. Still happy to chat.", '!lost'],
    ['Our CEO said to stop all vendor outreach until January, sorry.', '!lost'],
    ['Stop! This is exactly what we need. Call me.', '!lost'],
    ["Stop it, you're onto something. Call me Thursday.", '!lost'],
    ['Tell me more.\n\nThanks,\nKemi\n\nDon\'t want to hear from me? Unsubscribe here: https://hub.example/u/123', '!lost'],
    ['Please manage your preferences here: https://hub.example/prefs\nYes, interested.', '!lost'],
  ],
  'hostile': [
    ['this is spam, f*** off', 'hostile'], ['Spam. Reported.', 'hostile'], ['How did you get this address? This is spam.', 'hostile'],
    ['Fuck off.', 'hostile'], ['Leave me alone please', 'hostile'], ['This is spam. Go away.', 'hostile'], ['what a scam', 'hostile'],
    ['Go away.', 'hostile'], ['Just go away', 'hostile'], ['Please go away!', 'hostile'], ['Go away, this is spam', 'hostile'],
    ['This is bullshit', 'hostile'], ['Go to hell', 'hostile'], ['Piss off', 'hostile'], ["It's a scam", 'hostile'], ['You are a scammer', 'hostile'],
    ["You're spamming me.", 'hostile'], ['Stop spamming me', ['hostile', 'stop']], ['I will report you to my lawyer', 'hostile'],
    ['Spam.', ['hostile', 'stop']], ['Spam.\n\nSent from my iPhone', ['hostile', 'stop']], ['This email is rubbish, remove it', ['hostile', 'stop']],
    ['Leave me alone', 'hostile'],
  ],
  'not hostile': [
    ["Sorry for the stupid delay. Yes, let's talk.", '!lost'], ['My idiot filter caught your note. Happy to chat.', '!lost'],
    ['We got hit by a payment scam last year. How do you handle fraud?', 'question'], ['Holy shit, this is exactly what we need.', '!lost'],
    ['Wtf, that is a great idea. Call me.', '!lost'], ["I'll report your note to my boss, sounds promising.", '!lost'],
    ['We were targeted by scammers last year, how do you prevent fraud?', 'question'],
    ["Our current vendor? It's garbage. Tell me more about yours.", '!lost'], ["Excel? It's rubbish for this. Let's talk Tuesday.", '!lost'],
    ['Honestly our old tool was rubbish, this was rubbish too? No, kidding, when can we talk?', '!lost'],
    ['The team will go away and think about it, then come back to you.', '!lost'], ['We go away on holiday next week, after that keen to talk.', '!lost'],
    ['I hate spam but this one is actually relevant. Call me.', '!lost'], ['Is this spam?', '!lost'],
    ['Your note went to my spam folder, sorry. Happy to chat.', '!lost'],
    ['This could be a scam-proof way to reconcile? Tell me more.', '!lost'], ['Damn, that is exactly our problem. Call me.', '!lost'],
    ["honestly the last vendor was a scam, so I'm wary. what makes you different", '!lost'],
    ['We tried a vendor last year. It was a scam. How are you different?', '!lost'],
    ['Our HR team handles harassment cases, could this help?', '!lost'],
    ['Our CFO reported you were worth a call, so here I am. Free Thursday.', '!lost'],
    ['Go away? No, stay. Call me.', '!lost'],
    ["You are relentless, I will give you that. Fine, 15 minutes Tuesday.", '!lost'],
  ],
  'out of office (auto-replies stay out of the dock)': [
    ['I am out of the office until 3 Dec with limited access to email', 'out_of_office'],
    ['Automatic reply: Quick question, Kemi\n\nThank you for your email. I am currently out of the office and will respond on my return.', 'out_of_office'],
    ["I'm on annual leave until 16 November and will reply when I'm back.", 'out_of_office'],
    ['Auto-reply: I am travelling with limited access to email until Monday.', 'out_of_office'],
    ['OOO till Nov 20', 'out_of_office'],
    ['Thanks for your message. I am on maternity leave and will return in March 2027.', 'out_of_office'],
    ['Out of Office: back on Monday.', 'out_of_office'], ['Out of Office Re: Quick question, Kemi', 'out_of_office'],
    ['I will be on leave until next week.', 'out_of_office'], ["I'm away until the 15th, will reply then.", 'out_of_office'],
    ["I'm out sick today, back tomorrow.", 'out_of_office'],
    ['I am out of the office until 20 November. For anything urgent please contact Tolu.', 'out_of_office'],
    ['Je suis absent jusqu\'au 20 novembre. Pour toute urgence, contactez ops@okopay.com.', 'out_of_office'],
    ['Ich bin bis zum 20. November nicht im Büro.', 'out_of_office'],
    ['Automatische Antwort: Ich bin bis zum 20. November nicht im Büro, aber danke. Interesse an einem Gespräch?', 'out_of_office'],
    ['Réponse automatique : je suis absent jusqu\'au 20 novembre. Pouvez-vous me joindre ?', 'out_of_office'],
    ['Respuesta automática: estoy fuera de la oficina hasta el 20 de noviembre. ¿Algo urgente?', 'out_of_office'],
    ['Resposta automática: estou fora do escritório até 20 de novembro.', 'out_of_office'],
    ['Estoy fuera de la oficina hasta el 20 de noviembre.', 'out_of_office'], ['Estoy de vacaciones hasta el 3 de diciembre.', 'out_of_office'],
    ['Ich bin abwesend bis Montag.', 'out_of_office'], ['Estou fora do escritório até 20 de novembro.', 'out_of_office'], ['Estou de férias até 3 de dezembro.', 'out_of_office'],
    ['Je suis en congé.', 'out_of_office'], ['I am on leave until 20 November.', 'out_of_office'], ['On parental leave, back 2 February 2027', 'out_of_office'],
    ['I am on holiday until 14 December', 'out_of_office'], ['Automatic reply: limited access to email until 9 November', 'out_of_office'],
  ],
  'not an auto-reply': [
    ["We're currently out of budget for this. Maybe next year.", 'not_now'], ["Let's circle back on Monday.", 'interested'],
    ['Can we get back on Thursday to discuss?', 'interested'], ["I'm away from my desk but yes, interested.", 'interested'],
    ["I'm currently away from my desk; reply when back.", '!lost'], ["I'm currently away from my laptop, call me on 0803 555 0100.", '!lost'],
    ['I will be back on the project in January, happy to talk then.', '!lost'],
    ['On leave from my old role, now at Paystack. Happy to chat there.', '!lost'],
    ['We are fully remote and out of the office most days, but sure, a call works.', '!lost'],
    ['I am on leave this week but yes, interested. Call me Friday.', '!lost'],
    ["Away this week at a conference but keen. Let's talk when I'm back.", '!lost'],
    ["I'm in back-to-back meetings until Thursday, can we talk Friday?", '!lost'], ["I'm on holiday mood already lol. send me a deck?", '!lost'],
    ['Estoy fuera de la oficina hoy, pero sí, me interesa. ¿Hablamos el jueves?', '!lost'],
    ['Bin heute nicht im Büro, aber ja, gerne. Telefonat am Donnerstag?', '!lost'],
    ['Estou fora do escritório hoje, mas sim, tenho interesse. Podemos falar quinta?', '!lost'],
    ['Je suis en congé demain, mais oui, intéressé. Appelons-nous jeudi ?', '!lost'],
    ['Je serai absent jusqu’au 20 novembre, mais oui, appelons-nous ensuite ?', '!lost'],
    ['I have limited access to email this week, but yes, call me Thursday.', '!lost'],
    ["I'm covering for Tolu who is on maternity leave. Interested, send times.", '!lost'],
    ["I'm out of the office this week. Send me the deck and I'll read it.", '!lost'], ["I'm out of the office this week. Send me the deck.", '!lost'],
    ['On holiday. Send me the deck.', '!lost'],
    ['Send the deck.\n\nKemi Eze | CFO | Oko Pay\nNote: I work Mon-Thu and am out of the office on Fridays.', '!lost'],
    ["Send me the pricing.\n\nRegards,\nKemi\nOko Pay Ltd\nI'm out of the office on Fridays", '!lost'],
    ["Let's talk.\n\nBest regards\nKemi\n\nPlease note: I may have limited access to email over the holidays.", '!lost'],
    ['Out of office until Nov 20. Questions? Email ops@okopay.com', ['out_of_office', 'question', 'interested']],
  ],
  'real mail clients and signatures': [
    ["Yes, let's talk Thursday.\n\nSent from my iPhone", '!lost'], ['Sounds good, send times.\n\nGet Outlook for iOS<https://aka.ms/o0ukef>', '!lost'],
    ['Interested.\n\nSent from Yahoo Mail on Android', '!lost'], ['Happy to chat.\n-- \nKemi Eze\nCFO, Oko Pay\n+234 803 555 0100\nwww.okopay.com', '!lost'],
    ['Yes keen.\n\nBest,\nKemi\nCFO, Oko Pay\n+234 803 555 0100', '!lost'],
    ['Sure, Tuesday works.\n\nKind regards,\nKemi Eze\nHead of Finance\nOko Pay\n\nCONFIDENTIALITY NOTICE: This email and any attachments are confidential and intended solely for the addressee. If you are not the intended recipient, please notify the sender immediately and delete this email. Do not copy or distribute.', '!lost'],
    ['Send over details.\n\nKemi Eze\nCFO\n\nThis message was sent from an unmonitored mailbox. Please consider the environment before printing this email. Any views expressed are solely those of the author and do not represent Oko Pay.', '!lost'],
    ['Oui, parlons-en jeudi.\n\nEnvoyé de mon iPhone', '!lost'], ['Envoyé de mon iPhone', 'any' as unknown as ReplyKind],
    ['Thanks,\nKemi', '!lost'],
    ['yes intrested, whats the price' + sig, ['interested', 'question']],
    ['Sounds good. Send over some times next week?' + quoted, '!lost'],
    ["Hey Ada - good timing actually. We're drowning in recon right now. Thursday 2pm WAT?", '!lost'],
    ['Not for us at the moment, maybe revisit in Q2' + sig, ['not_interested', 'not_now']],
  ],
  'plain replies': [
    ['Thanks but no thanks.', 'not_interested'], ['Who gave you my email?', 'question'], ['No.', 'not_interested'], ['no', 'not_interested'],
    ['Maybe. Forward me something I can share with my CFO?', '!lost'], ['Danke, kein Interesse.', 'not_interested'],
    ["Merci, ça m'intéresse. On peut en parler la semaine prochaine ?", '!lost'], ['Gracias por escribir. ¿Cuánto cuesta?', '!lost'],
    ['Merci, pas intéressé.', 'not_interested'], ['Gracias, no me interesa.', 'not_interested'], ['Obrigado, não tenho interesse.', 'not_interested'],
    ['Gracias, pero no me interesa.\n\nSaludos,\nKemi', 'not_interested'],
    ['Please take me off your list.', 'stop'], ['I\'m not interested, thanks.', 'not_interested'], ['Not right now, maybe next quarter', 'not_now'],
    ['Can you tell me more about pricing?', 'question'], ['Happy to chat, does Thursday work?', 'interested'],
    ["Let's talk", 'interested'], ['Sounds good', 'interested'], ['Yes, please tell me more.', ['interested', 'question']],
    ["I'm interested, what does it cost?", '!lost'],
  ],
  'referrals': [
    ['You should talk to Sam Bello (sam@okopay.com), she runs finance', 'referral'],
    ['Kindly reach out to my colleague Chinedu, he leads ops.', 'referral'], ["I'll loop in Bisi from treasury.", 'referral'],
    ["This is great, cc'ing Funmi Ade who owns this.", 'referral'], ['Please contact my assistant Jane Doe (jane@okopay.com) to set this up.', 'referral'],
    ['Try our CFO, Sam Bello.', 'referral'], ['Leave me out of this, ask Tunde.', '!lost'],
    ["I'm not the right person, you want Tolu Adebayo (tolu.adebayo@okopay.com).", '!lost'],
    ['Please take me off this thread, but loop in Chidi Okafor.', 'referral'],
  ],
};

// ---- signatures and footers (fix round 4)
const okoBody = "Yes, let's talk Thursday.\n\nBest,\nKemi Eze\nCFO, Oko Pay\n\n";
const footerLines = [
  'CONFIDENTIALITY NOTICE: This email and any attachments are confidential and intended solely for the addressee. If you are not the intended recipient, please notify the sender immediately and delete this email. Do not copy or distribute.',
  'This e-mail and any files transmitted with it are confidential. If you have received this e-mail in error please notify the system manager. If you are not the named addressee you should not disseminate, distribute or copy this e-mail.',
  'If you are not the intended recipient, please do not read, copy or use it, and do not disclose it to others. Please notify the sender of the delivery error by replying to this message, and then delete it from your system.',
  'Oko Pay will never ask for your PIN or password. Never email us your card details.',
  'Security notice: Oko Pay staff will never email you asking for your password. Do not reply to emails requesting card details.',
  'If you no longer wish to receive emails from us, please reply with UNSUBSCRIBE in the subject line.',
  'If you would prefer not to receive marketing emails from Oko Pay, you can unsubscribe at any time.',
  'You can opt out of all marketing emails from Oko Pay at any time by replying to this email.',
  'Please do not email this address with payment queries; use payments@okopay.com.',
  'Please do not contact me outside working hours. I work Mon-Thu.',
  'I work flexible hours. Please do not email me back outside your own working hours.',
  "My working hours may not be your working hours. Please don't feel obliged to reply outside of yours.",
  'Please consider the environment before printing this email.',
  'Oko Pay Ltd is authorised by the Central Bank of Nigeria. Registered office: 12 Marina, Lagos.',
  'Beware of fraud: we will never change our bank details by email. If in doubt, call us.',
  'Scam alert: Oko Pay will never ask you to pay a fee. Report any scam emails to fraud@okopay.com.',
  "This is a scam warning: don't send money to anyone claiming to be us.",
  'Spam filter notice: this message was scanned and found clean.',
  'To unsubscribe from this group and stop receiving emails from it, send an email\nto oko-team+unsubscribe@googlegroups.com.',
  'Do not send me any more paper invoices; we are paperless.',
  'Please never call me on this number after 6pm.',
  'Stop.\nThink.\nRecycle.',
  'Out of office on Fridays.',
  'I am on leave from 20 Dec to 3 Jan.',
  'Note: I will be out of the office until 20 November.',
  'You can unsubscribe at any time.',
  'To unsubscribe, reply with UNSUBSCRIBE in the subject.',
  'You can opt out of marketing emails at any time.',
  'Manage your preferences or unsubscribe from this group.',
  'To stop receiving these emails, click the link in the footer\nor send a message to team+unsubscribe@oko.example.',
];
const legalFooters = [
  '\n\nCONFIDENTIALITY NOTICE: This email and any attachments are confidential and intended solely for the addressee. If you are not the intended recipient, please notify the sender immediately and delete this email. Do not copy or distribute.',
  '\n\nThis email was sent by Oko Pay Ltd. To unsubscribe from Oko Pay marketing emails, reply UNSUBSCRIBE. Oko Pay will never ask for your password.',
  '\n\nDisclaimer: If you have received this message in error, please contact the sender and remove it from your system. Do not contact us via this address for support requests; use support@okopay.com.',
  '\n\nThe information in this email is confidential. If you are not the intended recipient please do not read, copy, or forward. Please notify us immediately. Our office hours are Mon-Fri. I am out of the office on Fridays. This is not spam: you can opt out of our newsletter at any time.',
  "\n\nIMPORTANT: Oko Pay will never email you asking for payment details. If you receive such an email, it's a scam - report it to fraud@okopay.com. Do not reply to this email address.",
  '\n\nPrivileged & confidential. If received in error, please delete it and do not email us back. Stop and think before you print.',
  '\n\nOko Pay is regulated by the CBN. Opt out of marketing: reply STOP. Remove me from list requests are handled within 10 days.',
  '\n\nThis mailbox is unmonitored out of hours. Automatic reply messages may be sent. Do not contact me on weekends.',
];
const legalBodies = ["Yes, let's talk Friday.", 'Interested, send me the deck.', 'Tell me more about pricing?', 'Sure, Tuesday works.'];
const legalSigs = ['\n\nBest,\nKemi Eze\nCFO, Oko Pay', '\n\nKemi Eze\nCFO', ''];
const legalRows: Row[] = [];
for (const b of legalBodies) for (const g of legalSigs) for (const l of legalFooters) legalRows.push([b + g + l, '!lost']);

rows['signatures and footers'] = [
  // 1. a channel named in the signature, or in another sentence, never cancels an explicit opt-out
  ["Don't email me again.\n\nKemi Eze\nCFO, Oko Pay\nLinkedIn: linkedin.com/in/kemieze", 'stop'],
  ['Please do not contact me again.\n\nBest,\nKemi Eze\nCFO | Oko Pay\nWhatsApp: +234 803 555 0100', 'stop'],
  ['Do not email me.\n\nKemi Eze\nTel/WhatsApp +234 803 555 0100', 'stop'],
  ['Never contact me again.\n\nSent from my iPhone\nSMS me on +234 803 555 0100', 'stop'],
  ['Please don\'t email me again.\n\nKemi\nKemi Eze | CFO | Oko Pay | Find us on LinkedIn', 'stop'],
  ['Do not contact us anymore. We use Signal internally.', 'stop'],
  ["Don't email me again. Call me if you must, WhatsApp is no use.", 'stop'],
  ['Please do not contact me. Reach me on WhatsApp if there is a real emergency.', 'stop'],
  // ... but a different channel named in the same sentence is a change of channel
  ["Don't call me, email is best. Interested though.", '!lost'],
  ["Please don't call me, I prefer email. Send the details.", '!lost'],
  ["Interested. Don't text me, I'm on email.", '!lost'],
  ["Don't message me on LinkedIn, I'm rarely there. Yes, keen.", '!lost'],
  // 2. qualified or differently-aimed "don't" phrases are not opt-outs
  ["Don't email me on Fridays, but happy to chat Thursday.", '!lost'],
  ['Do not contact me before January. After that, yes.', '!lost'],
  ["Don't email me until after the audit, then let's talk.", '!lost'],
  ['Please never call me on this number after 6pm.', 'not_interested'],
  ["Never call me before 10am, but yes, interested.", '!lost'],
  ["Please don't contact me next week, I'm travelling. Week after works.", '!lost'],
  ["Don't send me any more attachments, our filter blocks them. Can you paste the pricing inline?", '!lost'],
  ['Never email us your card details.', 'not_interested'],
  ["Don't contact us through the website form, it's not monitored. This address is fine. Interested.", '!lost'],
  ["Please don't email us at the info@ address. Reply here.", 'not_interested'],
  ["Yes, let's talk Thursday.\n\nKemi Eze\nCFO, Oko Pay\nPlease do not contact me outside working hours.", '!lost'],
  ['Thursday works.\n\nKemi\nLeave me alone on weekends please :)', '!lost'],
  // plain opt-outs keep working, including ones with an "again" next to a place or a thing
  ["Please don't send me any more emails or messages.", 'stop'],
  ["Not interested.\n\nKind regards,\nKemi Eze\nCFO\n\nP.S. Please do not email me again.", 'stop'],
  // a footer or a signature never stops a person who is answering above it
  ...footerLines.map((f): Row => [okoBody + f, '!lost']),
  ...footerLines.map((f): Row => ['Interested, call me.\n\n' + f, '!lost']),
  ...legalRows,
  // 3. footer wording is skipped as a footer, hard-wrapped lines included, but short replies still count
  ['unsubscribe?', 'stop'], ['How do I unsubscribe?', 'stop'], ['Please unsubscribe me', 'stop'],
  ['I want to unsubscribe.', 'stop'], ["I'd like to unsubscribe from this list.", 'stop'], ['Is there a way to unsubscribe?', 'stop'],
  ['Please opt me out of all marketing emails.', 'stop'], ['I want to opt out of all marketing emails.', 'stop'],
  ['Hello,\n\nHow do I unsubscribe?\n\nKemi', 'stop'],
  ['I no longer wish to receive your emails.', 'stop'], ["I don't want to receive these emails.", 'stop'],
  ["Please do not email me again unless it is urgent.", 'stop'],
  ["Thanks,\nPlease don't email me again", 'stop'], ['Not interested.\nThanks,\nDo not email me again', 'stop'],
  ["Do not email me. Call me on 0803 555 0100 if you must.", 'stop'], ['Do not call me. Email is fine.', 'not_interested'],
  ['Please remove me.\nTo unsubscribe from marketing emails click https://x.co/u', 'stop'],
  // 4. any stop phrase beats an away message, an auto-reply header included
  ['Out of Office: back Monday. Who are you? Stop.', 'stop'], ['Away until 20 Nov. Not sure who you are, stop.', 'stop'],
  ["I'm out of the office until 20 Nov. Please remove me from your list.", 'stop'], ['Out of office. Stop.', 'stop'],
  ['Automatic reply: away until 20 Nov.\nStop.', 'stop'], ['On leave until December. Who are you? stop', 'stop'],
  ['Auto-reply: away until Monday. Unsubscribe?', 'stop'],
  ['Automatic reply: I am away. Do not reply to this message.', 'out_of_office'],
  ['Not sure who you are, stop.', 'stop'], ['not sure why I got this, please stop', 'stop'], ['Who are you, stop.', 'stop'],
  ['No idea who you are. stop', 'stop'], ['Stop. Not sure why I got this.', 'stop'], ['I am not sure. Stop.', 'stop'],
  ['STOP. Who are you?', ['stop', 'question']], ['Stop sending these. Where did you get my email?', ['stop', 'question']],
  ['Why do you keep emailing me? Stop.', ['stop', 'question']], ['Who is this? Stop.', ['stop', 'question']], ['Yes, stop.', ['stop', 'interested']],
  ['Stop?', ['stop', 'question']], ['Can I opt out?', ['stop', 'question']], ['opt out?', ['stop', 'question']],
  // 5. an away line in a signature is not an away message
  ['Thursday 2pm WAT.\n\nKemi Eze\nCFO\nOut of the office 20-24 Nov.', '!lost'],
  ['Ok, Thursday then.\n\nKemi Eze | CFO\nAway until 20 Nov, limited access to email.', '!lost'],
  ['Thursday 2pm WAT works.\n\nBest,\nKemi Eze\nCFO, Oko Pay\nOn annual leave until 20 November', '!lost'],
  ['Sure.\n\nKemi\n\nI am on annual leave until 20 November.', '!lost'],
  ['Thursday at 2.\n\nRegards,\nKemi\nAuto-reply: away until 20 Nov', '!lost'],
  ['Fine, 2pm Thursday.\n--\nKemi\nPlease note I am out of the office until 20 November.', '!lost'],
  ['Re: Quick question\nAutomatic reply: I am out of the office until 20 November.', 'out_of_office'],
  ['Out of Office: back Monday. Questions? call Tolu', 'out_of_office'],
  ['Hi,\n\nI am out of the office until Monday.\n\nBest,\nKemi Eze\nCFO', 'out_of_office'],
  ['Kemi Eze\nCFO\nOut of the office 20-24 Nov.', 'out_of_office'],
  ['Hello,\n\nKemi Eze\nOut of the office until 20 Nov.', 'out_of_office'],
  ['Not now, thanks.\n\nKemi Eze\nCFO\nOut of office 20-24 Nov', '!lost'],
  ['I am out of the office until 9am on Monday 16 November.', 'out_of_office'],
  // 6. a referral inside an opt-out must reach the dock
  ['Remove me from the list, speak to Sam Bello (sam@okopay.com) instead.', 'referral'],
  ["Stop emailing me, cc'ing Funmi Ade who owns this.", 'referral'],
  ['Please do not contact me again.', 'stop'], ["Don't contact Oko Pay again, remove me.", 'stop'],
];

// ---- opt-out scope (fix round 5)
// A "don't" phrase below the signature counts when the body above it is not engaged; a qualifier counts only inside the phrase's own clause;
// naming our own channel is not a qualifier; call/text/DM phrases are never an email opt-out; a referral needs a person.
const scopeStops = [
  // R1. below the signature, with nothing above that engages
  'Thanks for the note.\n\nBest,\nKemi\n\nPlease do not email me again.', "Got it.\n\nBest,\nKemi\n\nDon't contact me again.",
  'Thanks for reaching out.\n\nRegards,\nKemi\nDo not contact me again.', 'Noted.\n\nSent from my iPhone\n\nDo not email me again.',
  "Thanks for the note.\n--\nKemi\nDon't email me again", "Ok.\n\nBest,\nKemi\n\nDon't email me again.",
  'Not interested.\n\nBest,\nKemi Eze\nCFO\n\nDo not email me again.', 'Thanks for the note.\n\nKemi\n\nPlease do not email me again.',
  'Thanks for the note.\n\nBest,\nKemi Eze\nCFO\n\nPlease do not email me again.', 'Thanks for reaching out.\n\nRegards,\nKemi\n\nNever email me again.',
  'Thanks.\n\nBest,\nKemi\n\nPS do not email me again.', 'Read it.\n\nBest regards,\nKemi Eze\n\nPlease do not contact me again. I am not interested.',
  "Thanks for the note.\n\nBest,\nKemi\n\nI'm out of the office until Monday. Don't email me again.",
  "Thanks for the note.\n\nBest,\nKemi\n\nPlease don't email me anymore.", "Thanks,\nI'm not interested. Do not email me again.", 'Best,\nKemi\nDo not email me again.',
  // R2. a qualifier counts only in its own clause; again/ever/anymore beat conditions and time words
  'Do not contact me again, I said no before.', "Do not contact me, I've asked before.", 'Never contact me again, this is the third time this week.',
  "Don't contact me again, I've told you once.", 'Never email me again, not even once.', "Do not email me again, every week it's the same pitch.",
  'Do not email me again; I told you this on Monday.', 'Please do not contact me again, but good luck with your launch on Monday.',
  "Don't email me again if it's another sales pitch.", 'Never email me again unless you want me to report you.',
  'Do not contact me again unless I contact you first.', "Don't email me again, ever.", "Don't email me again ever.", "Do not email me again, I'm not interested now or ever.",
  "Do not email me again, we chose another vendor last month.", "Do not email me again, it's been 5 emails while I was on leave.", 'Do not email me again. I mean it.',
  "Don't email me. Ever.", "Do not email me, I never signed up for this.", 'Do not contact me from now on.', 'Do not contact me in the future.',
  "Don't email me when you have nothing to say. Actually just don't email me.", "Don't contact me before you've read my last email. Actually, don't contact me at all.",
  "Don't email me after this.", 'Do not email me after today.', "Please don't contact me after this message.",
  // R3. naming our own channel is not a qualifier
  'Please do not contact me by email.', 'Do not contact me via email.', 'Do not contact me by email or phone.', 'Do not contact me via any channel.',
  'Do not contact me on any channel.', 'Do not contact me at work.', 'Do not email me at this address.', 'Do not contact me at this email address.',
  "Please don't contact me at work.", 'Do not contact me via email again.', 'Do not contact me in any way.', "Don't contact me again, by email or phone.",
  // R4. email is one of the verbs
  'Do not email or call me.', "Don't email, call or text me.", "Don't EVER email me again.", 'Do NOT contact me.', 'Dont email me', 'Please do not e-mail me anymore.',
  // R6. no person is named
  'Do not contact me again. Speak to Legal.', 'Please unsubscribe me. cc Legal', 'Please stop. I am not talking to Sam Bello about this.',
  'Unsubscribe me and stop contacting John Smith too.', "Unsubscribe me. I'll talk to Sam Bello about how you got my address.",
  'Remove me. I will speak to Sam Bello in compliance.', 'Remove me. Do not contact Kemi Eze either.', "Stop emailing me. Contact our CEO if you must.",
  "Stop emailing me. I've cc'd Funmi Ade, our DPO, who will file a complaint.", 'Stop emailing me and Sam Bello.',
  // R7. more ways to say it
  'Stop reaching out.', 'Please stop reaching out to me.', 'Quit emailing me.', 'Cease all contact.', 'Please refrain from contacting me.',
  'Never email anyone at Oko Pay again.', 'Do not contact anyone at our company again.', "Don't email me or my colleagues again.",
  'Ne me contactez plus.', 'Bitte melden Sie mich ab.', 'Dejen de escribirme.', 'Pare de me enviar e-mails.', 'Bitte kontaktieren Sie mich nicht mehr.',
  'Por favor no me contacten más.', 'Ne me contactez plus.\n\nCordialement,\nKemi', 'Bitte melden Sie mich ab.\n\nGesendet von meinem iPhone',
  // R8. a link or footer wording on the same line never hides "unsubscribe me"
  'unsubscribe me https://example.com/x', 'Please unsubscribe me, I clicked the link https://x.co/u but it failed.',
  'Unsubscribe me. To unsubscribe from this list I already replied twice.', "I tried to unsubscribe but it didn't work. Please remove me.",
  'How do I unsubscribe? The link to unsubscribe is broken.', 'Manage your preferences? No. Remove me.', 'If you no longer wish to receive my replies, fine, but I no longer wish to receive your emails.',
  'I already clicked to unsubscribe. Stop emailing me.',
];
// matched an opt-out phrase but is not explicit: never stop, and never interested without engagement
rows['opt-out scope (round 5)'] = [
  ...scopeStops.map((f): Row => [f, 'stop']),
  // R1. the body above the signature is engaged, or the phrase is the footer's
  ['Yes, Thursday.\n\nKemi Eze\nCFO\nPlease do not email this address, it is not monitored.', '!lost'],
  ['Interested.\n\nBest,\nKemi Eze\nCFO\n\nDo not email me again.', '!lost'], ["Sure thing.\n\nBest,\nKemi\n\nDon't email me again.", '!lost'],
  ["Yes, let's talk Thursday.\n\nBest,\nKemi\n\nDon't email me again.", '!lost'],
  ['Interested, send the deck.\n\nThis mailbox is unmonitored. Do not email this address.', '!lost'], ['Do not email this address.', 'not_interested'],
  // R2. an end point, or a qualifier in the phrase's own clause
  ['Do not email me until next month.', 'not_interested'], ['Do not contact me until the end of time.', 'not_interested'],
  ["Don't email me if you value your reputation.", 'not_interested'], ['Do not email me before 9am.', 'not_interested'], ['Do not email me again before March.', 'not_interested'],
  // R3. another channel in the same sentence, or a channel that is not ours
  ['Do not email me, call me instead.', '!lost'], ['Do not email me, WhatsApp me instead.', 'not_interested'],
  ['Do not contact me through LinkedIn.', 'not_interested'], ['Do not contact me by phone.', 'not_interested'],
  // R4. call, phone, ring, text, SMS, WhatsApp and DM are never an email opt-out
  ["Please don't phone me. Happy to continue by email.", '!lost'], ["Don't call me. Send me the details by email.", '!lost'], ['Do not call me. Email me the deck.', '!lost'],
  ["Don't call me.", 'not_interested'], ['Do not text me.', 'not_interested'], ['Please do not call me again.', 'not_interested'], ["Don't DM me on LinkedIn again.", 'not_interested'],
  // R5. narrower than a stop, nothing engaged: the dock with a close suggested
  ["Don't email me the PDF.", 'not_interested'],
  // R6. a person is named
  ['Contact Sam Bello if you must.', 'referral'], ['Stop emailing me. Contact Sam Bello if you must.', 'referral'], ["Don't contact me, talk to Sam.", 'referral'],
];

const writer = new TemplateWriter(fixedClock('2026-11-02T10:00:00.000Z'));
const ctx = testCtx({ history: [outbound()] });

describe('classifier corpus', () => {
  for (const [group, list] of Object.entries(rows)) {
    describe(group, () => {
      it.each(list)('%j -> %s', async (text, expected) => {
        const { kind } = await writer.classify(text, ctx);
        if ((expected as string) === 'any') return;
        if (Array.isArray(expected)) expect(expected).toContain(kind);
        else if (expected === '!lost') expect(LOST).not.toContain(kind);
        else if (expected.startsWith('!')) expect(kind).not.toBe(expected.slice(1));
        else expect(kind).toBe(expected);
      });
    });
  }

  it('isExplicitOptOut agrees: true opt-outs are explicit, look-alikes are not', () => {
    for (const [text, expected] of rows['true opt-outs'] ?? []) {
      if (expected === 'stop' && /remove|unsubscribe|take me off|opt|contact|email|write|send/i.test(text)) expect(isExplicitOptOut(text), text).toBe(true);
    }
    for (const [text] of rows['an opt-out phrase that is not an opt-out'] ?? []) expect(isExplicitOptOut(text), text).toBe(false);
  });

  it('isExplicitOptOut agrees on the round 5 scope rows: stops are explicit, everything else is not', () => {
    for (const [text, expected] of rows['opt-out scope (round 5)'] ?? []) expect(isExplicitOptOut(text), text).toBe(expected === 'stop');
  });
});
