import { describe, expect, it } from 'vitest';
import { PROVIDER_PRESETS, bouncedRecipient, isBounce, mapSmtpError, stripQuoted } from './email-parse.js';

describe('stripQuoted', () => {
  it('drops a Gmail-style quoted block', () => {
    const text = [
      'Yes, Thursday at 9:00 works.',
      '',
      'On Mon, Nov 2, 2026 at 9:03 AM Gabriel <you@yourcompany.com> wrote:',
      '> Hi Kemi,',
      '> Are you free this week?',
    ].join('\n');
    expect(stripQuoted(text)).toBe('Yes, Thursday at 9:00 works.');
  });

  it('drops a Gmail quote header that wraps onto two lines', () => {
    const text = [
      'Sounds good.',
      '',
      'On Mon, Nov 2, 2026 at 9:03 AM Gabriel Femi Adeyemi <you@yourcompany.com>',
      'wrote:',
      '> Hi Kemi',
    ].join('\n');
    expect(stripQuoted(text)).toBe('Sounds good.');
  });

  it('drops an Outlook-style original message block', () => {
    const text = [
      'Please send the pricing.',
      '',
      '-----Original Message-----',
      'From: Gabriel <you@yourcompany.com>',
      'Sent: Monday, November 2, 2026 9:03 AM',
      'Subject: Hello',
      '',
      'Hi Kemi',
    ].join('\n');
    expect(stripQuoted(text)).toBe('Please send the pricing.');
  });

  it('drops an Outlook header block that has no original-message line', () => {
    const text = ['Not now, thanks.', '', '________________________________', 'From: Gabriel <you@yourcompany.com>', 'Sent: Monday, November 2, 2026 9:03 AM', 'To: Kemi', 'Subject: Hello', '', 'Hi Kemi'].join('\n');
    expect(stripQuoted(text)).toBe('Not now, thanks.');
  });

  it('removes quoted lines and keeps the lines written under them', () => {
    const text = ['> Are you free this week?', 'Yes, Thursday.', '> Or Friday?', 'Friday works too.'].join('\n');
    expect(stripQuoted(text)).toBe('Yes, Thursday.\nFriday works too.');
  });

  it('keeps text that merely mentions the word on or a colon', () => {
    const text = 'On reflection, I am in.\nFrom my side that is fine.';
    expect(stripQuoted(text)).toBe(text);
  });

  it('normalises Windows line endings and trims', () => {
    expect(stripQuoted('Hello\r\n\r\nOn Mon, X wrote:\r\n> hi\r\n')).toBe('Hello');
  });

  it('returns an empty string when everything is quoted', () => {
    expect(stripQuoted('> only a quote')).toBe('');
  });
});

const DSN = [
  'This is the mail system at host mx.example.com.',
  '',
  "I'm sorry to have to inform you that your message could not be delivered.",
  '',
  'Reporting-MTA: dns; mx.example.com',
  '',
  'Final-Recipient: rfc822; ghost@okopay.test',
  'Action: failed',
  'Status: 5.1.1',
  'Diagnostic-Code: smtp; 550 5.1.1 <ghost@okopay.test>: user unknown',
].join('\n');

describe('isBounce', () => {
  it('flags mailer-daemon and postmaster senders', () => {
    expect(isBounce('MAILER-DAEMON@mx.example.com', null, 'Hello')).toBe(true);
    expect(isBounce('Mail Delivery Subsystem <mailer-daemon@googlemail.com>', null, null)).toBe(true);
    expect(isBounce('postmaster@okopay.test', 'text/plain', 'Hi')).toBe(true);
  });
  it('flags a multipart/report', () => {
    expect(isBounce('robot@x.com', 'multipart/report; report-type=delivery-status; boundary=abc', 'Hello')).toBe(true);
  });
  it('flags bounce subjects', () => {
    expect(isBounce('robot@x.com', null, 'Undeliverable: Hello')).toBe(true);
    expect(isBounce('robot@x.com', null, 'Delivery Status Notification (Failure)')).toBe(true);
    expect(isBounce('robot@x.com', null, 'Mail delivery failed: returning message to sender')).toBe(true);
  });
  it('leaves an ordinary reply alone', () => {
    expect(isBounce('kemi@okopay.test', 'text/plain', 'Re: Hello')).toBe(false);
    expect(isBounce('kemi@okopay.test', null, null)).toBe(false);
  });
});

describe('bouncedRecipient', () => {
  it('reads Final-Recipient from a DSN', () => {
    expect(bouncedRecipient(DSN)).toBe('ghost@okopay.test');
  });
  it('reads Original-Recipient when there is no Final-Recipient', () => {
    expect(bouncedRecipient('Original-Recipient: rfc822;Ghost@OkoPay.test\nAction: failed')).toBe('ghost@okopay.test');
  });
  it('falls back to the first address that is not the sender', () => {
    const body = 'Delivery to the following recipient failed permanently:\n\n     ghost@okopay.test\n\nReply to postmaster@mx.example.com';
    expect(bouncedRecipient(body, 'mailer-daemon@mx.example.com')).toBe('ghost@okopay.test');
  });
  it('skips daemon addresses and the sender in the fallback', () => {
    expect(bouncedRecipient('From mailer-daemon@x.com about postmaster@x.com and you@yourcompany.com', 'you@yourcompany.com')).toBeNull();
  });
  it('returns null when there is no address', () => {
    expect(bouncedRecipient('Something went wrong')).toBeNull();
  });
});

describe('mapSmtpError', () => {
  it('maps authentication failures', () => {
    expect(mapSmtpError({ code: 'EAUTH' }).code).toBe('auth');
    expect(mapSmtpError({ responseCode: 535, message: 'Bad credentials' }).code).toBe('auth');
  });
  it('maps rejected recipients', () => {
    expect(mapSmtpError({ responseCode: 550 }).code).toBe('invalid_recipient');
    expect(mapSmtpError({ responseCode: 551 }).code).toBe('invalid_recipient');
    expect(mapSmtpError({ responseCode: 553 }).code).toBe('invalid_recipient');
  });
  it('maps temporary trouble', () => {
    for (const e of [{ code: 'ETIMEDOUT' }, { code: 'ECONNECTION' }, { responseCode: 421 }, { responseCode: 450 }, { responseCode: 451 }, { responseCode: 452 }]) {
      expect(mapSmtpError(e).code).toBe('temporary');
    }
  });
  it('maps anything else to unknown and keeps a message', () => {
    expect(mapSmtpError(new Error('weird')) ).toEqual({ code: 'unknown', message: 'weird' });
    expect(mapSmtpError('plain string')).toEqual({ code: 'unknown', message: 'plain string' });
    expect(mapSmtpError({ responseCode: 554, message: 'Rejected' }).code).toBe('unknown');
  });
});

describe('PROVIDER_PRESETS', () => {
  it('has the Google and Microsoft servers', () => {
    expect(PROVIDER_PRESETS.google).toEqual({ smtpHost: 'smtp.gmail.com', smtpPort: 465, smtpSecure: true, imapHost: 'imap.gmail.com', imapPort: 993 });
    expect(PROVIDER_PRESETS.microsoft).toEqual({ smtpHost: 'smtp.office365.com', smtpPort: 587, smtpSecure: false, imapHost: 'outlook.office365.com', imapPort: 993 });
  });
});
