import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { delimiter, dirname, join } from 'node:path';
import { z } from 'zod';

/**
 * Where Callum's Claude runs: the Claude Code already installed on this computer and signed in by its owner (their
 * own Claude plan), or the Claude API with a key the user gave. Callum never sees or stores a Claude sign-in.
 */
export type Engine = 'claude_code' | 'api';

export type ModelErrorCode = 'not_signed_in' | 'limit' | 'failed';

/** A failed call to Claude, with a message that is already plain words and never contains a key. */
export class ModelError extends Error {
  constructor(readonly code: ModelErrorCode, message: string) {
    super(message);
    this.name = 'ModelError';
  }
}

export interface ResearchOptions {
  /** The most web searches one run may make. */
  maxSearches?: number;
  timeoutMs?: number;
}

export interface Model {
  readonly engine: Engine;
  /** The last reason a call failed, for Your Callum and the logs. Never contains a key. */
  lastError: string | null;
  /** One structured answer, with no tools. Null when Claude could not answer; the caller falls back. */
  ask<S extends z.ZodType>(schema: S, system: string, user: string): Promise<z.infer<S> | null>;
  /** Searches the web and reads pages, then answers in the schema. Throws a ModelError. */
  research<S extends z.ZodType>(schema: S, system: string, user: string, opts?: ResearchOptions): Promise<z.infer<S>>;
  /** Told that the user has signed in since a call failed for want of it, so Callum stops waiting and the old error goes. */
  signedIn?(): void;
}

const MAX_TOKENS = 4000;
const RESEARCH_MAX_TOKENS = 16_000;
const DEFAULT_SEARCHES = 10;

const NOT_SIGNED_IN = "Claude Code isn't signed in on this computer. Open a terminal, run claude, and sign in with your Claude account.";
const LIMIT = "Your Claude plan's usage limit is reached for now. Callum tries again later.";
const FAILED = "Claude couldn't answer just now. Try again in a minute.";

/** A JSON Schema for a zod schema, without the `$schema` line the API and Claude Code do not need. */
export function jsonSchemaOf(schema: z.ZodType): Record<string, unknown> {
  const { $schema: _drop, ...rest } = z.toJSONSchema(schema) as Record<string, unknown>;
  return rest;
}

// ---- the Claude API, with the user's own key ------------------------------------------------------------

export class ApiModel implements Model {
  readonly engine = 'api' as const;
  lastError: string | null = null;
  private readonly client: Anthropic;

  constructor(private readonly apiKey: string, private readonly model: string, client?: Anthropic) {
    this.client = client ?? new Anthropic({ apiKey, timeout: 60_000, maxRetries: 1 });
  }

  private clean(reason: string): string {
    return this.apiKey ? reason.split(this.apiKey).join('[key]') : reason;
  }

  async ask<S extends z.ZodType>(schema: S, system: string, user: string): Promise<z.infer<S> | null> {
    try {
      const res = await this.client.messages.parse({
        model: this.model,
        max_tokens: MAX_TOKENS,
        output_config: { effort: 'low', format: zodOutputFormat(schema) },
        system,
        messages: [{ role: 'user', content: user }],
      });
      if (res.stop_reason === 'refusal') return this.failed('refused');
      if (res.parsed_output == null) return this.failed(`no valid output (stop reason ${res.stop_reason ?? 'unknown'})`);
      this.lastError = null;
      return res.parsed_output as z.infer<S>;
    } catch (err) {
      return this.failed(err instanceof Error ? err.message : 'request failed');
    }
  }

  private failed(reason: string): null {
    this.lastError = this.clean(reason);
    return null;
  }

  /**
   * Web search and web fetch run on Anthropic's side. Claude hands its answer to a `report` tool whose input is the
   * schema, because structured output can't be combined with the citations web search adds.
   */
  async research<S extends z.ZodType>(schema: S, system: string, user: string, opts: ResearchOptions = {}): Promise<z.infer<S>> {
    const searches = opts.maxSearches ?? DEFAULT_SEARCHES;
    const tools: Anthropic.ToolUnion[] = [
      { type: 'web_search_20260209', name: 'web_search', max_uses: searches },
      { type: 'web_fetch_20260209', name: 'web_fetch', max_uses: searches },
      {
        name: 'report',
        description: 'Call this once, at the end, with everything you found. Nothing you found counts until it is reported here.',
        input_schema: jsonSchemaOf(schema) as Anthropic.Tool.InputSchema,
      },
    ];
    const messages: Anthropic.MessageParam[] = [{ role: 'user', content: user }];
    let nudged = false;
    // The whole search has one time limit, however many times a paused turn is resumed.
    const deadline = Date.now() + (opts.timeoutMs ?? 300_000);
    try {
      for (let round = 0; round < 12; round++) {
        const left = deadline - Date.now();
        if (left <= 0) throw new ModelError('failed', 'Claude took too long to answer. Try again in a minute.');
        const res = await this.client.messages.create(
          { model: this.model, max_tokens: RESEARCH_MAX_TOKENS, output_config: { effort: 'medium' }, system, tools, messages },
          { timeout: left },
        );
        const report = res.content.find((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use' && b.name === 'report');
        if (report) {
          const parsed = schema.safeParse(report.input);
          if (parsed.success) {
            this.lastError = null;
            return parsed.data as z.infer<S>;
          }
          throw new ModelError('failed', FAILED);
        }
        if (res.stop_reason === 'refusal') throw new ModelError('failed', FAILED);
        if (res.stop_reason === 'max_tokens') throw new ModelError('failed', FAILED);
        messages.push({ role: 'assistant', content: res.content });
        // A paused server-side turn resumes from the assistant content alone.
        if (res.stop_reason === 'pause_turn') continue;
        if (nudged) break;
        nudged = true;
        messages.push({ role: 'user', content: 'Call report now with what you found. Report an empty list if you found nobody.' });
      }
      throw new ModelError('failed', FAILED);
    } catch (err) {
      if (err instanceof ModelError) {
        this.lastError = err.message;
        throw err;
      }
      const status = (err as { status?: unknown }).status;
      this.lastError = this.clean(err instanceof Error ? err.message : 'request failed');
      if (status === 401 || status === 403) throw new ModelError('not_signed_in', "Claude didn't accept the API key. Check it in Your Callum.");
      if (status === 429) throw new ModelError('limit', "Claude's rate limit is reached. Try again in a minute.");
      throw new ModelError('failed', FAILED);
    }
  }
}

// ---- Claude Code on this computer, signed in with the user's own Claude plan ---------------------------

export interface RunResult { code: number | null; stdout: string; stderr: string; timedOut: boolean }
export type Runner = (
  file: string,
  args: string[],
  opts: { input: string; cwd: string; timeoutMs: number; env: NodeJS.ProcessEnv },
) => Promise<RunResult>;

/**
 * Runs a program with the prompt on stdin. Never through a shell, so nothing in the prompt is interpreted. A `.js`
 * program (Claude Code installed with npm) runs on this process's own Node, so it works without `node` on the PATH,
 * which a desktop app opened from the Dock or Start menu often lacks.
 */
export const spawnRunner: Runner = (file, args, opts) =>
  new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let child;
    const script = /\.(c|m)?js$/i.test(file);
    try {
      child = spawn(script ? process.execPath : file, script ? [file, ...args] : args, {
        cwd: opts.cwd,
        // Inside Electron, its binary acts as plain Node with this set; Node itself ignores it.
        env: script ? { ...opts.env, ELECTRON_RUN_AS_NODE: '1' } : opts.env,
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      });
    } catch (err) {
      resolve({ code: null, stdout: '', stderr: err instanceof Error ? err.message : String(err), timedOut: false });
      return;
    }
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGINT');
      setTimeout(() => child.kill('SIGKILL'), 5000).unref();
    }, opts.timeoutMs);
    child.stdout.setEncoding('utf8').on('data', (d: string) => { stdout += d; });
    child.stderr.setEncoding('utf8').on('data', (d: string) => { if (stderr.length < 20_000) stderr += d; });
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ code: null, stdout, stderr: stderr + err.message, timedOut });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr, timedOut });
    });
    child.stdin.on('error', () => undefined);
    child.stdin.end(opts.input);
  });

/**
 * The environment Claude Code runs in. It signs in with its owner's own Claude account, so a key in Callum's
 * environment is taken out (it would be used instead). The folder Claude Code is in, and the usual places Node and
 * its helpers live, go first on the PATH: a desktop app opened from the Dock or Start menu has a short one.
 */
export function claudeCodeEnv(path: string, base: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base };
  delete env.ANTHROPIC_API_KEY;
  delete env.ANTHROPIC_AUTH_TOKEN;
  const key = platform === 'win32' ? (Object.keys(env).find((k) => k.toUpperCase() === 'PATH') ?? 'Path') : 'PATH';
  const sep = platform === 'win32' ? ';' : delimiter;
  const extra = [dirname(path), ...(platform === 'win32' ? [] : ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin'])];
  const current = (env[key] ?? '').split(sep).filter(Boolean);
  env[key] = [...extra.filter((d) => !current.includes(d)), ...current].join(sep);
  return env;
}

/** At most this many runs of a kind at a time, so a busy morning doesn't start a crowd of processes. */
function slots(max: number): <T>(work: () => Promise<T>) => Promise<T> {
  let running = 0;
  const waiting: (() => void)[] = [];
  return async (work) => {
    // A run woken from the queue looks again: another may have taken the free slot in between.
    while (running >= max) await new Promise<void>((r) => waiting.push(r));
    running++;
    try {
      return await work();
    } finally {
      running--;
      waiting.shift()?.();
    }
  };
}
// Writing and reading replies have slots of their own, so a search that takes minutes never holds up a send.
const askSlot = slots(2);
const researchSlot = slots(2);

const UPDATE = 'Callum needs a newer Claude Code. Open a terminal and run claude update.';

/** What a failed Claude Code run said, as one of Callum's own errors. Only Claude Code's own error words count. */
export function claudeCodeError(text: string): ModelError {
  if (/not logged in|please run \/login|invalid api key|oauth token (has )?expired|authentication_error|api error: 401/i.test(text)) return new ModelError('not_signed_in', NOT_SIGNED_IN);
  if (/usage limit|limit reached|rate_limit_error|api error: 429/i.test(text)) return new ModelError('limit', LIMIT);
  if (/unknown option|unknown argument/i.test(text)) return new ModelError('failed', UPDATE);
  return new ModelError('failed', FAILED);
}

/** After Claude Code says it is not signed in, Callum waits this long before asking it again. */
const SIGNED_OUT_PAUSE_MS = 5 * 60_000;

export interface ClaudeCodeOptions {
  /** A model name or alias for `--model`. Left out, Claude Code uses the model its owner chose. */
  model?: string | null;
  /** An empty folder Claude Code runs in, so no project's settings or files come along. */
  cwd: string;
  run?: Runner;
  now?: () => number;
}

/**
 * The `claude` program, run headless (`claude -p`) with no tools for writing and reading, and with only WebSearch and
 * WebFetch for finding people. It runs as published and signs in through its own flow; Callum only reads its answers.
 */
export class ClaudeCodeModel implements Model {
  readonly engine = 'claude_code' as const;
  lastError: string | null = null;
  private safeMode = true;
  private signedOutUntil = 0;
  private readonly run: Runner;
  private readonly now: () => number;

  constructor(readonly path: string, private readonly opts: ClaudeCodeOptions) {
    this.run = opts.run ?? spawnRunner;
    this.now = opts.now ?? Date.now;
  }

  signedIn(): void {
    if (this.signedOutUntil === 0 && this.lastError !== NOT_SIGNED_IN) return;
    this.signedOutUntil = 0;
    if (this.lastError === NOT_SIGNED_IN) this.lastError = null;
  }

  async ask<S extends z.ZodType>(schema: S, system: string, user: string): Promise<z.infer<S> | null> {
    if (this.now() < this.signedOutUntil) return null;
    try {
      return await this.call(schema, system, user, { tools: '', timeoutMs: 120_000, effort: 'low', maxTurns: 5 });
    } catch (err) {
      this.lastError = err instanceof Error ? err.message : String(err);
      return null;
    }
  }

  async research<S extends z.ZodType>(schema: S, system: string, user: string, opts: ResearchOptions = {}): Promise<z.infer<S>> {
    if (this.now() < this.signedOutUntil) throw new ModelError('not_signed_in', NOT_SIGNED_IN);
    try {
      // Sonnet searches well and quickly, and is light on the plan's limits; a model the user chose wins.
      const searches = opts.maxSearches ?? DEFAULT_SEARCHES;
      const budget = `\n\nMake at most ${searches} web searches in this run, then answer with what you found.`;
      return await this.call(schema, system + budget, user, {
        tools: 'WebSearch,WebFetch', timeoutMs: opts.timeoutMs ?? 300_000, model: this.opts.model || 'sonnet', maxTurns: searches * 3 + 10,
      });
    } catch (err) {
      this.lastError = err instanceof Error ? err.message : String(err);
      throw err;
    }
  }

  private async call<S extends z.ZodType>(
    schema: S, system: string, user: string, how: { tools: string; timeoutMs: number; effort?: 'low'; model?: string; maxTurns: number },
  ): Promise<z.infer<S>> {
    try {
      mkdirSync(this.opts.cwd, { recursive: true });
    } catch {
      // The folder is only somewhere quiet to run in; Claude Code still works without it being new.
    }
    const env = claudeCodeEnv(this.path);
    // The system prompt holds the user's own words (their offer, their sample hello), so it goes in a file only this
    // user can read rather than on the command line, where other programs could see it and its length is limited.
    const promptFile = join(this.opts.cwd, `system-${randomUUID()}.txt`);
    try {
      writeFileSync(promptFile, system, { mode: 0o600 });
    } catch {
      throw new ModelError('failed', FAILED);
    }
    try {
      return await this.runOnce(schema, user, how, env, promptFile);
    } finally {
      rmSync(promptFile, { force: true });
    }
  }

  private async runOnce<S extends z.ZodType>(
    schema: S, user: string, how: { tools: string; timeoutMs: number; effort?: 'low'; model?: string; maxTurns: number }, env: NodeJS.ProcessEnv, promptFile: string,
  ): Promise<z.infer<S>> {
    const args = (safe: boolean): string[] => [
      '-p',
      '--output-format', 'json',
      '--json-schema', JSON.stringify(jsonSchemaOf(schema)),
      '--system-prompt-file', promptFile,
      '--max-turns', String(how.maxTurns),
      '--tools', how.tools,
      ...(how.tools ? ['--allowedTools', how.tools] : []),
      '--permission-mode', 'dontAsk',
      '--no-session-persistence',
      ...(safe ? ['--safe-mode'] : []),
      ...(how.effort ? ['--effort', how.effort] : []),
      ...((how.model ?? this.opts.model) ? ['--model', (how.model ?? this.opts.model) as string] : []),
    ];
    const slot = how.tools ? researchSlot : askSlot;
    const once = () => slot(() => this.run(this.path, args(this.safeMode), { input: user, cwd: this.opts.cwd, timeoutMs: how.timeoutMs, env }));
    let res = await once();
    // Older Claude Code versions don't know --safe-mode; they still run correctly without it.
    if (this.safeMode && res.code !== 0 && /unknown option.*safe-mode/i.test(res.stderr)) {
      this.safeMode = false;
      res = await once();
    }
    if (res.timedOut) throw new ModelError('failed', 'Claude took too long to answer. Try again in a minute.');
    let out: Record<string, unknown> | null = null;
    try {
      const text = res.stdout.trim();
      const start = text.indexOf('{');
      const parsed: unknown = start === -1 ? null : JSON.parse(text.slice(start));
      out = parsed !== null && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
    } catch {
      out = null;
    }
    if (!out || out.is_error === true || out.subtype !== 'success') {
      const said = [typeof out?.result === 'string' ? out.result : '', res.stderr, String(out?.api_error_status ?? '')].join(' ');
      const error = res.code === null && !out ? new ModelError('failed', "Callum couldn't start Claude Code on this computer.") : claudeCodeError(said);
      if (error.code === 'not_signed_in') this.signedOutUntil = this.now() + SIGNED_OUT_PAUSE_MS;
      throw error;
    }
    this.signedOutUntil = 0;
    const parsed = schema.safeParse(out.structured_output);
    if (!parsed.success) throw new ModelError('failed', FAILED);
    this.lastError = null;
    return parsed.data as z.infer<S>;
  }
}
