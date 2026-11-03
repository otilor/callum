import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { claudeCodeStatus, findClaudeCode } from './claudeCode.js';
import type { RunResult, Runner } from './model.js';

function program(dir: string, name = 'claude'): string {
  mkdirSync(dir, { recursive: true });
  const file = join(dir, name);
  writeFileSync(file, '#!/bin/sh\necho hi\n');
  chmodSync(file, 0o755);
  return file;
}

describe('findClaudeCode', () => {
  it('uses CALLUM_CLAUDE_PATH when it is set, and only when it runs', () => {
    const dir = mkdtempSync(join(tmpdir(), 'callum-cc-'));
    const file = program(join(dir, 'bin'));
    expect(findClaudeCode({ CALLUM_CLAUDE_PATH: file, PATH: '' }, 'linux')).toBe(file);
    expect(findClaudeCode({ CALLUM_CLAUDE_PATH: join(dir, 'missing'), PATH: join(dir, 'bin') }, 'linux')).toBeNull();
  });

  it('looks on the PATH first', () => {
    const dir = mkdtempSync(join(tmpdir(), 'callum-cc-'));
    const file = program(join(dir, 'tools'));
    expect(findClaudeCode({ PATH: join(dir, 'tools'), HOME: dir }, 'linux')).toBe(file);
  });

  it("finds it where the installer puts it when a desktop app's PATH is short", () => {
    const home = mkdtempSync(join(tmpdir(), 'callum-cc-'));
    const file = program(join(home, '.local', 'bin'));
    expect(findClaudeCode({ PATH: '/nowhere', HOME: home }, 'linux')).toBe(file);
  });

  it('skips a file that cannot run, and a folder named claude', () => {
    const home = mkdtempSync(join(tmpdir(), 'callum-cc-'));
    mkdirSync(join(home, 'a', 'claude'), { recursive: true });
    writeFileSync(join(home, 'b-claude'), 'x');
    mkdirSync(join(home, 'b'));
    writeFileSync(join(home, 'b', 'claude'), 'not runnable');
    chmodSync(join(home, 'b', 'claude'), 0o644);
    const found = findClaudeCode({ PATH: [join(home, 'a'), join(home, 'b')].join(':'), HOME: home }, 'linux');
    expect(found === null || !found.startsWith(home)).toBe(true);
  });

  it('looks for claude.exe on Windows, and nowhere else when it is not there', () => {
    const home = mkdtempSync(join(tmpdir(), 'callum-cc-'));
    program(join(home, '.local', 'bin'));
    expect(findClaudeCode({ PATH: '', USERPROFILE: home, HOME: '' }, 'win32')).toBeNull();
    const exe = program(join(home, '.local', 'bin'), 'claude.exe');
    expect(findClaudeCode({ PATH: '', USERPROFILE: home, HOME: '' }, 'win32')).toBe(exe);
  });
});

describe('claudeCodeStatus', () => {
  const answering = (r: Partial<RunResult>): { run: Runner; args: string[][] } => {
    const args: string[][] = [];
    return {
      args,
      run: async (_file, a, opts) => {
        args.push(a);
        expect(opts.env.ANTHROPIC_API_KEY).toBeUndefined();
        return { code: 0, stdout: '', stderr: '', timedOut: false, ...r };
      },
    };
  };
  const cwd = join(tmpdir(), 'callum-cc-status');

  it('says signed in, and how, from claude auth status', async () => {
    const { run, args } = answering({ stdout: JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', apiProvider: 'firstParty' }) });
    expect(await claudeCodeStatus('/usr/local/bin/claude', cwd, run)).toEqual({ found: true, signedIn: true, account: 'claude.ai' });
    expect(args).toEqual([['auth', 'status']]);
  });

  it('says found but not signed in', async () => {
    const { run } = answering({ code: 1, stdout: JSON.stringify({ loggedIn: false }) });
    expect(await claudeCodeStatus('claude', cwd, run)).toEqual({ found: true, signedIn: false, account: null });
  });

  it('says not found when there is no program, or it does not start', async () => {
    expect(await claudeCodeStatus(null, cwd, answering({}).run)).toEqual({ found: false, signedIn: false, account: null });
    expect(await claudeCodeStatus('/nowhere/claude', cwd, answering({ code: null, stderr: 'ENOENT' }).run)).toEqual({ found: false, signedIn: false, account: null });
  });

  it('falls back to the exit code on an older Claude Code that prints text', async () => {
    expect(await claudeCodeStatus('claude', cwd, answering({ code: 0, stdout: 'Logged in' }).run)).toEqual({ found: true, signedIn: true, account: null });
  });
});
