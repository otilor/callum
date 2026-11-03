import type Anthropic from '@anthropic-ai/sdk';
import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { ApiModel, ClaudeCodeModel, claudeCodeEnv, claudeCodeError, jsonSchemaOf, ModelError, spawnRunner, type RunResult, type Runner } from './model.js';

const schema = z.object({ answer: z.string() });

interface Call { file: string; args: string[]; input: string; cwd: string; timeoutMs: number; env: NodeJS.ProcessEnv; system: string | null }

/** A Claude Code that answers from a script and records how it was run. */
function fakeClaude(...answers: Partial<RunResult>[]): { run: Runner; calls: Call[] } {
  const calls: Call[] = [];
  const run: Runner = async (file, args, opts) => {
    const promptFile = args[args.indexOf('--system-prompt-file') + 1];
    calls.push({ file, args, ...opts, system: promptFile && existsSync(promptFile) ? readFileSync(promptFile, 'utf8') : null });
    // Each run has its own scripted answer: a retry or a second launch nobody expected fails the test.
    if (calls.length > answers.length) throw new Error(`Claude Code ran ${calls.length} times; the test expected ${answers.length}.`);
    const a = answers[calls.length - 1] ?? {};
    return { code: 0, stdout: '', stderr: '', timedOut: false, ...a };
  };
  return { run, calls };
}

const success = (structured: unknown): Partial<RunResult> => ({
  stdout: JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: '', structured_output: structured }),
});
const failure = (result: string, extra: Record<string, unknown> = {}): Partial<RunResult> => ({
  code: 1, stdout: JSON.stringify({ type: 'result', subtype: 'success', is_error: true, result, ...extra }),
});

const flag = (args: string[], name: string): string | undefined => {
  const i = args.indexOf(name);
  return i === -1 ? undefined : args[i + 1];
};

describe('ClaudeCodeModel', () => {
  it('asks headless with no tools, the schema, the system prompt, and the question on stdin', async () => {
    const { run, calls } = fakeClaude(success({ answer: 'yes' }));
    const prev = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = 'sk-ant-callum-env';
    try {
      const m = new ClaudeCodeModel('/usr/local/bin/claude', { cwd: '/tmp/callum-test/claude-code', run });
      expect(await m.ask(schema, 'Be brief.', 'Is it Monday?')).toEqual({ answer: 'yes' });
    } finally {
      if (prev === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = prev;
    }
    const [call] = calls;
    expect(call?.file).toBe('/usr/local/bin/claude');
    expect(call?.input).toBe('Is it Monday?');
    expect(call?.cwd).toBe('/tmp/callum-test/claude-code');
    const args = call?.args ?? [];
    expect(args[0]).toBe('-p');
    expect(flag(args, '--output-format')).toBe('json');
    expect(JSON.parse(flag(args, '--json-schema') ?? '{}')).toEqual(jsonSchemaOf(schema));
    // The system prompt carries the user's own words, so it goes in a file only they can read, gone after the run.
    expect(args).not.toContain('--system-prompt');
    expect(call?.system).toBe('Be brief.');
    const promptFile = flag(args, '--system-prompt-file') ?? '';
    expect(promptFile.startsWith(join('/tmp/callum-test/claude-code', 'system-'))).toBe(true);
    expect(existsSync(promptFile)).toBe(false);
    expect(flag(args, '--max-turns')).toBe('5');
    expect(flag(args, '--tools')).toBe('');
    expect(args).not.toContain('--allowedTools');
    expect(flag(args, '--permission-mode')).toBe('dontAsk');
    expect(args).toEqual(expect.arrayContaining(['--no-session-persistence', '--safe-mode']));
    expect(flag(args, '--effort')).toBe('low');
    // The owner's chosen model is used for writing; the Claude sign-in is Claude Code's own, never a key of Callum's.
    expect(args).not.toContain('--model');
    expect(args).not.toContain('--bare');
    expect(call?.env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(call?.env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
    // Neither prompt is ever put on the command line.
    expect(args.join(' ')).not.toContain('Is it Monday?');
    expect(args.join(' ')).not.toContain('Be brief.');
  });

  it('researches with only web search and web fetch, on Sonnet unless a model was chosen', async () => {
    const first = fakeClaude(success({ answer: 'found' }));
    const m = new ClaudeCodeModel('claude', { cwd: '/tmp/callum-test/cc', run: first.run });
    expect(await m.research(schema, 'Find.', 'Who?')).toEqual({ answer: 'found' });
    const args = first.calls[0]?.args ?? [];
    expect(flag(args, '--tools')).toBe('WebSearch,WebFetch');
    expect(flag(args, '--allowedTools')).toBe('WebSearch,WebFetch');
    expect(flag(args, '--model')).toBe('sonnet');
    expect(flag(args, '--max-turns')).toBe('40');
    expect(first.calls[0]?.system).toBe('Find.\n\nMake at most 10 web searches in this run, then answer with what you found.');
    expect(first.calls[0]?.timeoutMs).toBe(300_000);

    const chosen = fakeClaude(success({ answer: 'found' }));
    await new ClaudeCodeModel('claude', { cwd: '/tmp/callum-test/cc', run: chosen.run, model: 'opus' }).research(schema, 'Find.', 'Who?', { timeoutMs: 1000, maxSearches: 20 });
    expect(flag(chosen.calls[0]?.args ?? [], '--model')).toBe('opus');
    expect(flag(chosen.calls[0]?.args ?? [], '--max-turns')).toBe('70');
    expect(chosen.calls[0]?.timeoutMs).toBe(1000);
  });

  it('runs again without --safe-mode on a Claude Code that does not know it, and remembers', async () => {
    const { run, calls } = fakeClaude({ code: 1, stderr: "error: unknown option '--safe-mode'" }, success({ answer: 'ok' }), success({ answer: 'ok' }));
    const m = new ClaudeCodeModel('claude', { cwd: '/tmp/callum-test/cc', run });
    expect(await m.ask(schema, 's', 'u')).toEqual({ answer: 'ok' });
    expect(await m.ask(schema, 's', 'u')).toEqual({ answer: 'ok' });
    expect(calls.map((c) => c.args.includes('--safe-mode'))).toEqual([true, false, false]);
  });

  it('says plainly when Claude Code is not signed in, and leaves it alone for five minutes', async () => {
    let now = 1_000_000;
    const { run, calls } = fakeClaude(failure('Not logged in · Please run /login'), success({ answer: 'back' }));
    const m = new ClaudeCodeModel('claude', { cwd: '/tmp/callum-test/cc', run, now: () => now });
    const err = await m.research(schema, 's', 'u').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ModelError);
    expect((err as ModelError).code).toBe('not_signed_in');
    expect((err as ModelError).message).toContain('run claude, and sign in');
    expect(m.lastError).toContain('sign in');
    // Within the pause nothing runs: writing falls back to templates, a search says why.
    expect(await m.ask(schema, 's', 'u')).toBeNull();
    await expect(m.research(schema, 's', 'u')).rejects.toMatchObject({ code: 'not_signed_in' });
    expect(calls).toHaveLength(1);
    now += 5 * 60_000 + 1;
    expect(await m.ask(schema, 's', 'u')).toEqual({ answer: 'back' });
    expect(m.lastError).toBeNull();
  });

  it('tells a plan limit, a slow answer, a missing program and a wrong answer apart', async () => {
    const limit = new ClaudeCodeModel('claude', { cwd: '/tmp/callum-test/cc', run: fakeClaude(failure("Claude AI usage limit reached|1762250400")).run });
    await expect(limit.research(schema, 's', 'u')).rejects.toMatchObject({ code: 'limit', message: expect.stringContaining('usage limit') });

    const slow = new ClaudeCodeModel('claude', { cwd: '/tmp/callum-test/cc', run: fakeClaude({ code: null, timedOut: true }).run });
    await expect(slow.research(schema, 's', 'u')).rejects.toMatchObject({ code: 'failed', message: expect.stringContaining('too long') });

    const missing = new ClaudeCodeModel('/nowhere/claude', { cwd: '/tmp/callum-test/cc', run: fakeClaude({ code: null, stderr: 'spawn ENOENT' }).run });
    await expect(missing.research(schema, 's', 'u')).rejects.toMatchObject({ code: 'failed', message: expect.stringContaining("couldn't start Claude Code") });

    const wrong = new ClaudeCodeModel('claude', { cwd: '/tmp/callum-test/cc', run: fakeClaude(success({ nope: 1 }), success({ nope: 1 })).run });
    await expect(wrong.research(schema, 's', 'u')).rejects.toMatchObject({ code: 'failed' });
    expect(await wrong.ask(schema, 's', 'u')).toBeNull();

    const garbage = new ClaudeCodeModel('claude', { cwd: '/tmp/callum-test/cc', run: fakeClaude({ code: 1, stdout: 'Segmentation fault' }).run });
    await expect(garbage.research(schema, 's', 'u')).rejects.toMatchObject({ code: 'failed' });

    const old = new ClaudeCodeModel('claude', { cwd: '/tmp/callum-test/cc', run: fakeClaude({ code: 1, stderr: "error: unknown option '--json-schema'" }).run });
    await expect(old.research(schema, 's', 'u')).rejects.toMatchObject({ code: 'failed', message: expect.stringContaining('claude update') });
  });

  it('stops waiting as soon as Claude Code is signed in again', async () => {
    const { run, calls } = fakeClaude(failure('Not logged in · Please run /login'), success({ answer: 'back' }));
    const m = new ClaudeCodeModel('claude', { cwd: '/tmp/callum-test/cc', run, now: () => 1_000_000 });
    await expect(m.research(schema, 's', 'u')).rejects.toMatchObject({ code: 'not_signed_in' });
    expect(await m.ask(schema, 's', 'u')).toBeNull();
    m.signedIn();
    expect(m.lastError).toBeNull();
    expect(await m.ask(schema, 's', 'u')).toEqual({ answer: 'back' });
    expect(calls).toHaveLength(2);
  });

  it('treats words with no JSON in them as a failed run', async () => {
    const m = new ClaudeCodeModel('claude', { cwd: '/tmp/callum-test/cc', run: fakeClaude({ code: 0, stdout: 'Done in 2' }).run });
    await expect(m.research(schema, 's', 'u')).rejects.toMatchObject({ code: 'failed' });
  });

  it('reads the answer after any warning printed before it', async () => {
    const { run } = fakeClaude({ stdout: `warning: update available\n${JSON.stringify({ subtype: 'success', is_error: false, structured_output: { answer: 'x' } })}` });
    expect(await new ClaudeCodeModel('claude', { cwd: '/tmp/callum-test/cc', run }).ask(schema, 's', 'u')).toEqual({ answer: 'x' });
  });

  it('never makes writing wait behind a long search', async () => {
    let release = () => undefined as void;
    const searching = new Promise<void>((r) => { release = r; });
    const run: Runner = async (_file, args) => {
      if (args.includes('WebSearch,WebFetch')) await searching;
      return { code: 0, stdout: JSON.stringify({ subtype: 'success', is_error: false, structured_output: { answer: 'a' } }), stderr: '', timedOut: false };
    };
    const m = new ClaudeCodeModel('claude', { cwd: '/tmp/callum-test/cc', run });
    const searches = [m.research(schema, 's', 'u'), m.research(schema, 's', 'u'), m.research(schema, 's', 'u')];
    expect(await m.ask(schema, 's', 'u')).toEqual({ answer: 'a' });
    release();
    await Promise.all(searches);
  });

  it('runs at most two at a time', async () => {
    let live = 0;
    let most = 0;
    const run: Runner = async () => {
      live++;
      most = Math.max(most, live);
      await new Promise((r) => setTimeout(r, 5));
      live--;
      return { code: 0, stdout: JSON.stringify({ subtype: 'success', is_error: false, structured_output: { answer: 'a' } }), stderr: '', timedOut: false };
    };
    const m = new ClaudeCodeModel('claude', { cwd: '/tmp/callum-test/cc', run });
    const answers = await Promise.all(Array.from({ length: 5 }, () => m.ask(schema, 's', 'u')));
    expect(answers.every((a) => a?.answer === 'a')).toBe(true);
    expect(most).toBe(2);
  });
});

describe('claudeCodeError', () => {
  it('maps what Claude Code says to a sign-in, a limit, or a plain failure', () => {
    expect(claudeCodeError('Invalid API key · Please run /login').code).toBe('not_signed_in');
    expect(claudeCodeError('OAuth token has expired').code).toBe('not_signed_in');
    expect(claudeCodeError('API Error: 429 Too Many Requests').code).toBe('limit');
    expect(claudeCodeError('Claude AI usage limit reached').code).toBe('limit');
    expect(claudeCodeError('API Error: 529 overloaded').code).toBe('failed');
    // Words about other sign-ins, such as LinkedIn's, are not Claude Code's.
    expect(claudeCodeError('Could not open the LinkedIn login page to sign in').code).toBe('failed');
    expect(claudeCodeError("error: unknown option '--max-turns'").message).toContain('claude update');
  });
});

describe('claudeCodeEnv', () => {
  it('takes out Callum\'s own keys and puts the folders Claude Code needs first on the PATH', () => {
    const env = claudeCodeEnv('/Users/ada/.local/bin/claude', { PATH: '/usr/bin:/bin', ANTHROPIC_API_KEY: 'k', ANTHROPIC_AUTH_TOKEN: 't', HOME: '/Users/ada' }, 'darwin');
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
    expect(env.HOME).toBe('/Users/ada');
    expect(env.PATH).toBe('/Users/ada/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin');
  });

  it('keeps the Windows Path spelling', () => {
    const env = claudeCodeEnv('C:\\Users\\ada\\.local\\bin\\claude.exe', { Path: 'C:\\Windows' }, 'win32');
    expect(env.Path?.endsWith(';C:\\Windows')).toBe(true);
    expect(env.PATH).toBeUndefined();
  });
});

describe('spawnRunner', () => {
  it('runs a .js program (an npm install of Claude Code) on this Node, even with no node on the PATH', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'callum-js-'));
    const cli = join(dir, 'cli.js');
    writeFileSync(cli, 'process.stdin.on("data", (d) => process.stdout.write(process.argv[2] + ":" + d));');
    expect(statSync(cli).isFile()).toBe(true);
    const res = await spawnRunner(cli, ['-p'], { input: 'hi', cwd: dir, timeoutMs: 10_000, env: { PATH: '' } });
    expect(res).toMatchObject({ code: 0, stdout: '-p:hi' });
  });

  it('passes the prompt on stdin, with no shell in between', async () => {
    const res = await spawnRunner(process.execPath, ['-e', 'process.stdin.pipe(process.stdout)'], {
      input: 'hello $(whoami) `id` ; rm -rf /', cwd: process.cwd(), timeoutMs: 10_000, env: process.env,
    });
    expect(res).toMatchObject({ code: 0, stdout: 'hello $(whoami) `id` ; rm -rf /', timedOut: false });
  });

  it('stops a run that takes too long', async () => {
    const res = await spawnRunner(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { input: '', cwd: process.cwd(), timeoutMs: 200, env: process.env });
    expect(res.timedOut).toBe(true);
  });

  it('reports a program that is not there instead of throwing', async () => {
    const res = await spawnRunner('/nowhere/claude', [], { input: '', cwd: process.cwd(), timeoutMs: 5000, env: process.env });
    expect(res.code).toBeNull();
    expect(res.stderr).toContain('ENOENT');
  });
});

// ---- the API, with a key ---------------------------------------------------------------------------------

type Created = { body: Anthropic.MessageCreateParamsNonStreaming; opts: unknown };

function fakeClient(replies: (Partial<Anthropic.Message> | Error)[], parsed?: unknown): { client: Anthropic; created: Created[] } {
  const created: Created[] = [];
  const client = {
    messages: {
      create: async (body: Anthropic.MessageCreateParamsNonStreaming, opts: unknown) => {
        created.push({ body: structuredClone(body), opts });
        const r = replies[created.length - 1];
        if (r instanceof Error) throw r;
        return { stop_reason: 'end_turn', content: [], ...r };
      },
      parse: async () => {
        if (parsed instanceof Error) throw parsed;
        return { stop_reason: 'end_turn', parsed_output: parsed ?? null };
      },
    },
  } as unknown as Anthropic;
  return { client, created };
}

const report = (input: unknown): Partial<Anthropic.Message> => ({
  stop_reason: 'tool_use',
  content: [{ type: 'tool_use', id: 'tu_1', name: 'report', input, caller: { type: 'direct' } } as unknown as Anthropic.ContentBlock],
});

describe('ApiModel', () => {
  it('researches with web search, web fetch and a report tool, and resumes a paused turn', async () => {
    const searching = { type: 'server_tool_use', id: 'st_1', name: 'web_search', input: { query: 'cfo lagos' } } as unknown as Anthropic.ContentBlock;
    const { client, created } = fakeClient([{ stop_reason: 'pause_turn', content: [searching] }, report({ answer: 'Kemi' })]);
    const m = new ApiModel('sk-ant-k', 'claude-opus-5-5', client);
    expect(await m.research(schema, 'Find.', 'Who?', { maxSearches: 7 })).toEqual({ answer: 'Kemi' });
    expect(created).toHaveLength(2);
    const tools = created[0]?.body.tools as { type?: string; name: string; max_uses?: number; input_schema?: unknown }[];
    expect(tools.map((t) => t.type ?? t.name)).toEqual(['web_search_20260209', 'web_fetch_20260209', 'report']);
    expect(tools[0]?.max_uses).toBe(7);
    expect(tools[2]?.input_schema).toEqual(jsonSchemaOf(schema));
    // The paused turn goes back as the assistant's content, and nothing else is added.
    expect(created[1]?.body.messages).toEqual([{ role: 'user', content: 'Who?' }, { role: 'assistant', content: [searching] }]);
  });

  it('asks once for the report when Claude stops without it, then gives up', async () => {
    const said = { type: 'text', text: 'I found Kemi.' } as unknown as Anthropic.ContentBlock;
    const nudged = fakeClient([{ content: [said] }, report({ answer: 'Kemi' })]);
    expect(await new ApiModel('k', 'm', nudged.client).research(schema, 's', 'u')).toEqual({ answer: 'Kemi' });
    expect(nudged.created[1]?.body.messages.at(-1)).toMatchObject({ role: 'user', content: expect.stringContaining('Call report now') });

    const silent = fakeClient([{ content: [said] }, { content: [said] }]);
    await expect(new ApiModel('k', 'm', silent.client).research(schema, 's', 'u')).rejects.toMatchObject({ code: 'failed' });
    expect(silent.created).toHaveLength(2);
  });

  it('gives the whole search one time limit, however often a paused turn resumes', async () => {
    const searching = { type: 'server_tool_use', id: 'st_1', name: 'web_search', input: { query: 'q' } } as unknown as Anthropic.ContentBlock;
    const timeouts: number[] = [];
    const client = {
      messages: {
        create: async (_body: unknown, opts: { timeout: number }) => {
          timeouts.push(opts.timeout);
          await new Promise((r) => setTimeout(r, 40));
          return { stop_reason: 'pause_turn', content: [searching] };
        },
      },
    } as unknown as Anthropic;
    await expect(new ApiModel('k', 'm', client).research(schema, 's', 'u', { timeoutMs: 100 })).rejects.toMatchObject({ code: 'failed', message: expect.stringContaining('too long') });
    expect(timeouts.length).toBeGreaterThan(1);
    expect(timeouts.length).toBeLessThanOrEqual(3);
    expect(timeouts[0]).toBeLessThanOrEqual(100);
    for (let i = 1; i < timeouts.length; i++) expect(timeouts[i]!).toBeLessThan(timeouts[i - 1]!);
  });

  it('turns a refused key and a rate limit into plain words, without the key', async () => {
    const refused = Object.assign(new Error('401 invalid x-api-key sk-ant-SECRET'), { status: 401 });
    const m = new ApiModel('sk-ant-SECRET', 'm', fakeClient([refused]).client);
    await expect(m.research(schema, 's', 'u')).rejects.toMatchObject({ code: 'not_signed_in', message: expect.stringContaining("didn't accept the API key") });
    expect(m.lastError).not.toContain('sk-ant-SECRET');
    const limited = Object.assign(new Error('429'), { status: 429 });
    await expect(new ApiModel('k', 'm', fakeClient([limited]).client).research(schema, 's', 'u')).rejects.toMatchObject({ code: 'limit' });
    await expect(new ApiModel('k', 'm', fakeClient([report({ nope: true })]).client).research(schema, 's', 'u')).rejects.toMatchObject({ code: 'failed' });
  });

  it('answers a question in the schema, or null with the reason kept', async () => {
    expect(await new ApiModel('k', 'm', fakeClient([], { answer: 'yes' }).client).ask(schema, 's', 'u')).toEqual({ answer: 'yes' });
    const m = new ApiModel('sk-ant-SECRET', 'm', fakeClient([], new Error('boom sk-ant-SECRET')).client);
    expect(await m.ask(schema, 's', 'u')).toBeNull();
    expect(m.lastError).toBe('boom [key]');
  });
});
