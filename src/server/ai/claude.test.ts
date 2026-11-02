import Anthropic from '@anthropic-ai/sdk';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, expect, it, vi } from 'vitest';
import { fixedClock } from '../engine/clock.js';
import { ClaudeWriter } from './claude.js';
import { inbound, outbound, testCtx, testProject } from './testing.test-helpers.js';
import { TemplateWriter } from './templates.js';
import { createWriter } from './writer.js';

const clock = fixedClock('2026-11-02T10:00:00.000Z');
const template = new TemplateWriter(clock);
const KEY = 'sk-ant-test-secret-key';

type Reply = { parsed_output: unknown; stop_reason?: string };
function fakeClient(reply: Reply | Error) {
  const parse = vi.fn(async (_params: Record<string, unknown>) => {
    if (reply instanceof Error) throw reply;
    return { stop_reason: 'end_turn', ...reply };
  });
  return { client: { messages: { parse } } as unknown as Anthropic, parse };
}
const writerWith = (reply: Reply | Error) => {
  const { client, parse } = fakeClient(reply);
  return { writer: new ClaudeWriter(KEY, 'claude-opus-5-5', template, client, clock), parse };
};
const requestOf = (parse: ReturnType<typeof fakeClient>['parse']) => parse.mock.calls[0]![0] as {
  model: string; max_tokens: number; system: string; messages: { role: string; content: string }[];
  output_config: { effort: string; format: { type: string; schema: { properties: Record<string, unknown> } } };
  thinking?: unknown; temperature?: unknown;
};

describe('ClaudeWriter request shape', () => {
  it('sends model, low effort, a JSON schema, a system prompt and the user message', async () => {
    const { writer, parse } = writerWith({ parsed_output: { body: 'Hi Kemi, a short and honest note.' } });
    await writer.write('hello', testCtx({ project: testProject({ tone: 'direct', sample: 'Hey Tola, saw your post on payouts.' }) }));
    expect(parse).toHaveBeenCalledOnce();
    const req = requestOf(parse);
    expect(req.model).toBe('claude-opus-5-5');
    expect(req.max_tokens).toBeGreaterThanOrEqual(2000);
    expect(req.output_config.effort).toBe('low');
    expect(req.output_config.format.type).toBe('json_schema');
    expect(Object.keys(req.output_config.format.schema.properties)).toEqual(['body']);
    expect(req.thinking).toBeUndefined();
    expect(req.temperature).toBeUndefined();
    expect(req.messages).toHaveLength(1);
    expect(req.messages[0]).toMatchObject({ role: 'user' });
    expect(req.system).toContain('No exclamation marks');
    expect(req.system).toContain('Under 90 words');
    expect(req.system).toContain('[YOUR PRICE]');
    expect(req.system).toContain('Ada Obi');
    expect(req.system).toContain("take reconciliation off their ops team's plate");
    expect(req.system).toContain('direct: brief');
    expect(req.system).toContain('Hey Tola, saw your post on payouts.');
    expect(req.system).toContain('language of their message');
    expect(req.messages[0]!.content).toContain('Kemi Eze');
    expect(req.messages[0]!.content).toContain('Oko Pay');
  });
  it('mentions the 280-character limit for an invite and carries the calendar link for a booking', async () => {
    const a = writerWith({ parsed_output: { body: 'Hi Kemi, glad to connect.' } });
    await a.writer.write('invite', testCtx({ channel: 'linkedin' }));
    expect(requestOf(a.parse).system).toContain('280 characters');
    const b = writerWith({ parsed_output: { body: 'Great. Pick a time: https://cal.example.com/ada' } });
    await b.writer.write('booking', testCtx());
    expect(requestOf(b.parse).system).toContain('https://cal.example.com/ada');
  });
  it('puts the conversation so far into the prompt', async () => {
    const { writer, parse } = writerWith({ parsed_output: { body: 'Thanks, Kemi. Does Thursday at 9:00 work?' } });
    await writer.write('reply', testCtx({ history: [outbound(), outbound({ id: 2, direction: 'in', kind: 'inbound', subject: null, body: 'Can you tell me more about pricing?' })] }));
    expect(requestOf(parse).messages[0]!.content).toContain('Can you tell me more about pricing?');
  });
  it('uses the model it was given', async () => {
    const { client, parse } = fakeClient({ parsed_output: { name: 'Payroll' } });
    await new ClaudeWriter(KEY, 'claude-sonnet-5-5', template, client, clock).projectName('You help teams run payroll.');
    expect(requestOf(parse).model).toBe('claude-sonnet-5-5');
  });
});

describe('ClaudeWriter results', () => {
  it('write returns Claude\'s body with the template subject, and removes exclamation marks', async () => {
    const { writer } = writerWith({ parsed_output: { body: '  Hi Kemi! Quick one about reconciliation at Oko Pay.  ' } });
    const out = await writer.write('hello', testCtx());
    expect(out).toEqual({ subject: 'Quick question, Kemi', body: 'Hi Kemi. Quick one about reconciliation at Oko Pay.' });
  });
  it('write keeps an ALL-CAPS placeholder for the guard to catch, but not a merge field', async () => {
    const ok = await writerWith({ parsed_output: { body: 'Thanks, Kemi. It costs [YOUR PRICE] a month.' } }).writer.write('reply', testCtx());
    expect(ok.body).toContain('[YOUR PRICE]');
    const merged = await writerWith({ parsed_output: { body: 'Hi {first_name}, hello.' } }).writer.write('hello', testCtx());
    expect(merged).toEqual(await template.write('hello', testCtx()));
  });
  it('write clamps an invite to 280 characters', async () => {
    const long = `Hi Kemi, ${'I help finance teams close faster and with fewer late nights. '.repeat(8)}`;
    const out = await writerWith({ parsed_output: { body: long } }).writer.write('invite', testCtx({ channel: 'linkedin' }));
    expect(out.body.length).toBeLessThanOrEqual(280);
    expect(out.subject).toBeNull();
  });
  it('classify returns the parsed classification', async () => {
    const parsed = {
      kind: 'referral', suggested: 'reply', returnDate: '2026-11-20', referral: { name: 'Sam Bello', email: 'sam@okopay.com', context: 'she runs finance' }, language: 'EN',
    };
    const { writer, parse } = writerWith({ parsed_output: parsed });
    const out = await writer.classify('Talk to Sam', testCtx());
    expect(out).toEqual({ kind: 'referral', suggested: 'reply', returnDate: null, referral: parsed.referral, language: 'en' });
    const req = requestOf(parse);
    expect(req.system).toContain('Monday, 2 November 2026');
    expect(Object.keys(req.output_config.format.schema.properties)).toEqual(['kind', 'suggested', 'returnDate', 'referral', 'language']);
  });
  it('classify keeps a valid return date for out of office and drops a bad one', async () => {
    const base = { kind: 'out_of_office', suggested: 'snooze', referral: null, language: 'en' };
    expect((await writerWith({ parsed_output: { ...base, returnDate: '2026-11-20' } }).writer.classify('away', testCtx())).returnDate).toBe('2026-11-20');
    expect((await writerWith({ parsed_output: { ...base, returnDate: '2026-02-31' } }).writer.classify('away', testCtx())).returnDate).toBeNull();
    expect((await writerWith({ parsed_output: { ...base, returnDate: 'next Tuesday' } }).writer.classify('away', testCtx())).returnDate).toBeNull();
  });
  it('classify never lets a softer reading override an opt-out the phrase rules caught', async () => {
    const soft = { kind: 'interested', suggested: 'reply', returnDate: null, referral: null, language: 'en' };
    const out = await writerWith({ parsed_output: soft }).writer.classify('Please take me off your list.', testCtx());
    expect(out.kind).toBe('stop');
  });
  it('classify falls back when a referral has no name', async () => {
    const bad = { kind: 'referral', suggested: 'reply', returnDate: null, referral: null, language: 'en' };
    const out = await writerWith({ parsed_output: bad }).writer.classify('Happy to chat, does Thursday work?', testCtx());
    expect(out).toEqual(await template.classify('Happy to chat, does Thursday work?', testCtx()));
  });
  it('offerLine returns a clean one-sentence line, else the template result', async () => {
    const line = 'You help fintech teams close their books in two days.';
    expect(await writerWith({ parsed_output: { offer: line } }).writer.offerLine('We help fintech teams close their books in two days.', 'okopay.com')).toBe(line);
    expect(await writerWith({ parsed_output: { offer: '[WHAT YOU OFFER]' } }).writer.offerLine('Welcome. Cookies.', 'x.com')).toBe('[WHAT YOU OFFER]');
    expect(await writerWith({ parsed_output: { offer: 'We are great!' } }).writer.offerLine('We help fintech teams reconcile faster.', 'x.com')).toBe('You help fintech teams reconcile faster.');
  });
  it('offerLine does not call the API for empty site text', async () => {
    const { writer, parse } = writerWith({ parsed_output: { offer: 'You help.' } });
    expect(await writer.offerLine('  ', 'x.com')).toBe('[WHAT YOU OFFER]');
    expect(parse).not.toHaveBeenCalled();
  });
  it('projectName returns Claude\'s short name, else the template one', async () => {
    const offer = "You help fintech teams take reconciliation off their ops team's plate.";
    expect(await writerWith({ parsed_output: { name: 'Reconciliation.' } }).writer.projectName(offer)).toBe('Reconciliation');
    expect(await writerWith({ parsed_output: { name: 'Four words is too many' } }).writer.projectName(offer)).toBe('Reconciliation');
    expect(await writerWith({ parsed_output: { name: 'Great!' } }).writer.projectName(offer)).toBe('Reconciliation');
  });
  it('parseAsk maps the structured intent and checks ids against the people list', async () => {
    const people = [{ id: 11, name: 'Kemi Eze' }, { id: 12, name: 'Nneka Obi' }];
    const base = { likePersonId: null, query: null, count: null, channel: null, tone: null, personIds: [] as number[] };
    const run = (o: object) => writerWith({ parsed_output: { ...base, ...o } }).writer.parseAsk('anything', people);
    expect(await run({ intent: 'warm' })).toEqual({ intent: 'warm' });
    expect(await run({ intent: 'find', likePersonId: 11, count: 80 })).toEqual({ intent: 'find', likePersonId: 11, query: null, count: 50 });
    expect(await run({ intent: 'find', query: 'cfos in Accra' })).toEqual({ intent: 'find', likePersonId: null, query: 'cfos in Accra', count: 20 });
    expect(await run({ intent: 'pause', channel: 'x' })).toEqual({ intent: 'pause', channel: 'x' });
    expect(await run({ intent: 'tone', tone: 'playful' })).toEqual({ intent: 'tone', tone: 'playful' });
    expect(await run({ intent: 'switch', personIds: [12, 99, 12], channel: 'email' })).toEqual({ intent: 'switch', personIds: [12], channel: 'email' });
    expect(await run({ intent: 'find', likePersonId: 99 })).toEqual({ intent: 'unknown' });
    expect(await run({ intent: 'pause' })).toEqual({ intent: 'unknown' });
  });
});

describe('ClaudeWriter.classify guards', () => {
  const classified = (kind: string, suggested: string, extra: object = {}) => ({ kind, suggested, returnDate: null, referral: null, language: 'en', ...extra });

  it('sends the reply without its quoted history', async () => {
    const { writer, parse } = writerWith({ parsed_output: classified('interested', 'reply') });
    await writer.classify("Yes, let's talk.\n\nOn Mon, 2 Nov 2026 at 09:00, Ada Obi <ada@example.com> wrote:\n> If this isn't for you, just reply stop and I won't write again.", testCtx());
    const content = requestOf(parse).messages[0]!.content;
    expect(content).toContain("Yes, let's talk.");
    expect(content).not.toContain('just reply stop');
    expect(content).not.toContain('wrote:');
  });
  it('sends everything they typed, signature included, and none of the quoted history', async () => {
    const { writer, parse } = writerWith({ parsed_output: classified('interested', 'reply') });
    await writer.classify('Thank you.\nPlease remove me from your list.\n\nBest,\nKemi Eze\nHead of Finance\n\nOn Mon, 2 Nov 2026 at 09:00, Ada Obi <ada@example.com> wrote:\n> hello there', testCtx());
    const content = requestOf(parse).messages[0]!.content;
    expect(content).toContain('Please remove me from your list.');
    expect(content).toContain('Head of Finance');
    expect(content).not.toContain('hello there');
  });
  it.each([
    ['stop', 'reply', 'close'],
    ['hostile', 'book', 'close'],
    ['not_interested', 'reply', 'close'],
    ['out_of_office', 'reply', 'snooze'],
    ['not_now', 'book', 'snooze'],
    ['question', 'book', 'reply'],
    ['referral', 'snooze', 'reply'],
    ['interested', 'snooze', 'reply'],
    ['interested', 'book', 'book'],
    ['interested', 'reply', 'reply'],
  ])('%s with suggested %s becomes %s', async (kind, suggested, expected) => {
    const referral = kind === 'referral' ? { name: 'Sam Bello', email: null, context: 'ask Sam' } : null;
    const out = await writerWith({ parsed_output: classified(kind, suggested, { referral }) }).writer.classify('Anything', testCtx());
    expect(out.kind).toBe(kind);
    expect(out.suggested).toBe(expected);
  });
  it('keeps an explicit opt-out even if Claude reads it softly', async () => {
    for (const text of ['Please take me off your list.', 'unsubscribe', 'STOP', "Don't email me again.", 'Hi Ada,\n\nThank you.\nPlease remove me from your list.\n\nRegards,\nKemi']) {
      const out = await writerWith({ parsed_output: classified('interested', 'reply') }).writer.classify(text, testCtx());
      expect(out.kind).toBe('stop');
    }
  });
  it('lets Claude correct the template when the template only guessed', async () => {
    const out = await writerWith({ parsed_output: classified('interested', 'reply') }).writer.classify("Stop it, you're onto something. Call me Thursday.", testCtx());
    expect(out.kind).toBe('interested');
    const hostile = await writerWith({ parsed_output: classified('interested', 'book') }).writer.classify('This is a scam? No, kidding. Call me.', testCtx());
    expect(hostile.kind).toBe('interested');
  });
  it('resolves the date against the inbound message date', async () => {
    const ctx = testCtx({ history: [outbound(), inbound({ at: '2026-11-02T08:30:00.000Z' })] });
    const { writer, parse } = writerWith({ parsed_output: classified('out_of_office', 'snooze', { returnDate: '2026-11-20' }) });
    const out = await writer.classify('away', ctx);
    expect(out.returnDate).toBe('2026-11-20');
    expect(requestOf(parse).system).toContain('Monday, 2 November 2026');
  });
});

describe('ClaudeWriter.write length and punctuation', () => {
  const words = (n: number) => `Hi Kemi, ${Array.from({ length: n }, (_, i) => `word${i}`).join(' ')}`;
  it('accepts a hello up to 120 words and a reply up to 160, and falls back beyond', async () => {
    const ctx = testCtx();
    expect((await writerWith({ parsed_output: { body: words(100) } }).writer.write('hello', ctx)).body).toBe(words(100));
    expect((await writerWith({ parsed_output: { body: words(130) } }).writer.write('hello', ctx)).body).toBe((await template.write('hello', ctx)).body);
    expect((await writerWith({ parsed_output: { body: words(130) } }).writer.write('follow_up', ctx)).body).toBe((await template.write('follow_up', ctx)).body);
    expect((await writerWith({ parsed_output: { body: words(150) } }).writer.write('reply', ctx)).body).toBe(words(150));
    expect((await writerWith({ parsed_output: { body: words(170) } }).writer.write('reply', ctx)).body).toBe((await template.write('reply', ctx)).body);
  });
  it('removes "!" and the Spanish opening "¡"', async () => {
    const out = await writerWith({ parsed_output: { body: '¡Hola Kemi! Gracias por tu respuesta. ¡Qué bien!' } }).writer.write('reply', testCtx());
    expect(out.body).toBe('Hola Kemi. Gracias por tu respuesta. Qué bien.');
  });
});

describe('ClaudeWriter falls back to the templates', () => {
  const ctx = testCtx();
  const people = [{ id: 11, name: 'Kemi Eze' }];
  const cases: [string, Reply | Error][] = [
    ['an API error', new Error('529 overloaded')],
    ['a refusal', { parsed_output: null, stop_reason: 'refusal' }],
    ['a refusal that still carries output', { parsed_output: { body: 'x' }, stop_reason: 'refusal' }],
    ['output that did not parse', { parsed_output: null, stop_reason: 'end_turn' }],
    ['a response cut off at max tokens', { parsed_output: null, stop_reason: 'max_tokens' }],
  ];
  it.each(cases)('on %s, every method returns the template result', async (_name, reply) => {
    const { writer } = writerWith(reply);
    expect(await writer.write('hello', ctx)).toEqual(await template.write('hello', ctx));
    expect(await writer.write('invite', testCtx({ channel: 'linkedin' }))).toEqual(await template.write('invite', testCtx({ channel: 'linkedin' })));
    expect(await writer.classify('Not right now, maybe next quarter', ctx)).toEqual(await template.classify('Not right now, maybe next quarter', ctx));
    expect(await writer.offerLine('We help fintech teams reconcile faster.', 'x.com')).toBe('You help fintech teams reconcile faster.');
    expect(await writer.parseAsk('pause LinkedIn', people)).toEqual({ intent: 'pause', channel: 'linkedin' });
    expect(await writer.projectName('You help growing teams run payroll without spreadsheets.')).toBe('Payroll');
  });
  it('rejects empty and overlong drafts', async () => {
    const empty = await writerWith({ parsed_output: { body: '   ' } }).writer.write('hello', ctx);
    expect(empty).toEqual(await template.write('hello', ctx));
    const huge = await writerWith({ parsed_output: { body: 'word '.repeat(600) } }).writer.write('hello', ctx);
    expect(huge).toEqual(await template.write('hello', ctx));
  });
  it('keeps the reason for the last fallback, without the API key', async () => {
    const { writer } = writerWith(new Error(`401 invalid x-api-key ${KEY}`));
    await writer.write('hello', ctx);
    expect(writer.lastError).toContain('401');
    expect(writer.lastError).not.toContain(KEY);
    const ok = writerWith({ parsed_output: { body: 'Hi Kemi, hello there.' } });
    await ok.writer.write('hello', ctx);
    expect(ok.writer.lastError).toBeNull();
  });
});

describe('createWriter', () => {
  it('returns the template writer without a key, and Claude with one', () => {
    expect(createWriter({})).toBeInstanceOf(TemplateWriter);
    expect(createWriter({ ANTHROPIC_API_KEY: '  ' })).toBeInstanceOf(TemplateWriter);
    expect(createWriter({ ANTHROPIC_API_KEY: KEY })).toBeInstanceOf(ClaudeWriter);
    expect(createWriter({ ANTHROPIC_API_KEY: KEY, CALLUM_MODEL: 'claude-sonnet-5-5' })).toBeInstanceOf(ClaudeWriter);
  });
  it('the default writer works end to end without a key', async () => {
    const w = createWriter({});
    expect((await w.write('hello', testCtx())).body).toContain('Kemi');
  });
});

describe('ClaudeWriter with the real SDK against a local server', () => {
  it('sends the documented request and reads the structured reply from the response text', async () => {
    const seen: { url?: string; headers?: Record<string, unknown>; body?: Record<string, unknown> } = {};
    const server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        seen.url = req.url;
        seen.headers = req.headers;
        seen.body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({
          id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-opus-5-5', stop_reason: 'end_turn', stop_sequence: null,
          content: [{ type: 'text', text: JSON.stringify({ body: 'Hi Kemi, a short note about reconciliation.' }) }],
          usage: { input_tokens: 10, output_tokens: 10 },
        }));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const client = new Anthropic({ apiKey: KEY, baseURL: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, maxRetries: 0 });
      const writer = new ClaudeWriter(KEY, 'claude-opus-5-5', template, client, clock);
      const out = await writer.write('hello', testCtx());
      expect(out.body).toBe('Hi Kemi, a short note about reconciliation.');
      expect(seen.url).toBe('/v1/messages');
      expect(seen.headers?.authorization).toBe(`Bearer ${KEY}`);
      expect(seen.body).toMatchObject({ model: 'claude-opus-5-5', output_config: { effort: 'low', format: { type: 'json_schema' } } });
      expect(seen.body).not.toHaveProperty('thinking');
      expect(seen.body).not.toHaveProperty('temperature');
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
  it('falls back when the server answers with an error', async () => {
    const server = createServer((_req, res) => {
      res.statusCode = 401;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } }));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const client = new Anthropic({ apiKey: KEY, baseURL: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, maxRetries: 0 });
      const writer = new ClaudeWriter(KEY, 'claude-opus-5-5', template, client, clock);
      expect(await writer.write('hello', testCtx())).toEqual(await template.write('hello', testCtx()));
      expect(writer.lastError).toContain('401');
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
