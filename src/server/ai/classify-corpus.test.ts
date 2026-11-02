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
    ["I don't email much, WhatsApp me on 0803 555 0100 and let's talk.", '!stop'],
    ['Can we opt out of the annual plan and pay monthly?', '!stop'],
    ['We do not write our own recon scripts, so yes, interested.', '!stop'],
    ["Don't contact sales, contact me directly. When are you free?", '!stop'],
    ["Don't email me at 9am, email me at kemi@okopay.com instead.", '!stop'],
    ["Please don't email me here, WhatsApp me on 0803 555 0100.", '!stop'],
    ["Don't send me the PDF, just call me on Thursday.", '!stop'],
    ["We've been non-stop since launch. Can we talk next month?", '!stop'],
    ["We're a one-stop shop, how is this different?", '!stop'],
    ['We are a nonstop operation right now. Interested though.', '!stop'],
    ["Please don't stop, keen to hear more.", '!stop'],
    ["I can't stop thinking about the reconciliation problem. Tell me more.", '!stop'],
    ["Full stop, we're happy with our current setup.", 'not_interested'],
    ['Stop by our office on Thursday?', '!stop'], ['stop by our booth at Afritech, stand 42', '!stop'], ['pls stop by our booth at Afritech, stand 42', '!stop'],
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
    ['Please take me off this thread, but loop in Chidi Okafor.', 'stop'],
  ],
};

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
});
