import { chmodSync, mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
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

  it.skipIf(process.platform === 'win32')('skips a folder named claude and a file that cannot run, and takes the next one on the PATH', () => {
    const home = mkdtempSync(join(tmpdir(), 'callum-cc-'));
    mkdirSync(join(home, 'a', 'claude'), { recursive: true });
    mkdirSync(join(home, 'b'));
    writeFileSync(join(home, 'b', 'claude'), 'not runnable');
    chmodSync(join(home, 'b', 'claude'), 0o644);
    const good = program(join(home, 'c'));
    expect(findClaudeCode({ PATH: [join(home, 'a'), join(home, 'b'), join(home, 'c')].join(delimiter), HOME: home }, 'linux')).toBe(good);
  });

  it.skipIf(process.platform === 'win32')('runs the cli.js behind an npm link, so a Dock-launched app needs no node on its PATH', () => {
    const root = mkdtempSync(join(tmpdir(), 'callum-cc-'));
    const pkg = join(root, 'lib', 'node_modules', '@anthropic-ai', 'claude-code');
    mkdirSync(pkg, { recursive: true });
    const cli = join(pkg, 'cli.js');
    writeFileSync(cli, '#!/usr/bin/env node\n');
    chmodSync(cli, 0o755);
    mkdirSync(join(root, 'bin'));
    symlinkSync(cli, join(root, 'bin', 'claude'));
    expect(findClaudeCode({ PATH: join(root, 'bin'), HOME: root }, 'linux')).toBe(realpathSync(cli));
  });

  it("finds an npm install on Windows by its claude.cmd, and runs the cli.js behind it", () => {
    const home = mkdtempSync(join(tmpdir(), 'callum-cc-'));
    const npm = join(home, 'AppData', 'Roaming', 'npm');
    mkdirSync(join(npm, 'node_modules', '@anthropic-ai', 'claude-code'), { recursive: true });
    writeFileSync(join(npm, 'claude.cmd'), '@node cli.js %*');
    const cli = join(npm, 'node_modules', '@anthropic-ai', 'claude-code', 'cli.js');
    writeFileSync(cli, '');
    expect(findClaudeCode({ PATH: '', USERPROFILE: home, APPDATA: join(home, 'AppData', 'Roaming') }, 'win32')).toBe(cli);
    expect(findClaudeCode({ CALLUM_CLAUDE_PATH: join(npm, 'claude.cmd') }, 'win32')).toBe(cli);
  });

  it('finds claude.exe on the Windows Path, split by semicolons', () => {
    const home = mkdtempSync(join(tmpdir(), 'callum-cc-'));
    const exe = program(join(home, 'Programs', 'Claude'), 'claude.exe');
    expect(findClaudeCode({ Path: [join(home, 'nothing'), join(home, 'Programs', 'Claude')].join(';'), USERPROFILE: home }, 'win32')).toBe(exe);
  });

  it('finds a project-local npm install on Windows, in node_modules/.bin', () => {
    const root = mkdtempSync(join(tmpdir(), 'callum-cc-'));
    const bin = join(root, 'node_modules', '.bin');
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, 'claude.cmd'), '@node ..\\@anthropic-ai\\claude-code\\cli.js %*');
    mkdirSync(join(root, 'node_modules', '@anthropic-ai', 'claude-code'), { recursive: true });
    const cli = join(root, 'node_modules', '@anthropic-ai', 'claude-code', 'cli.js');
    writeFileSync(cli, '');
    expect(findClaudeCode({ CALLUM_CLAUDE_PATH: join(bin, 'claude.cmd') }, 'win32')).toBe(join(bin, '..', '@anthropic-ai', 'claude-code', 'cli.js'));
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
    expect(await claudeCodeStatus('/usr/local/bin/claude', cwd, run)).toEqual({ found: true, runs: true, signedIn: true, account: 'claude.ai' });
    expect(args).toEqual([['auth', 'status']]);
  });

  it('says found but not signed in', async () => {
    const { run } = answering({ code: 1, stdout: JSON.stringify({ loggedIn: false }) });
    expect(await claudeCodeStatus('claude', cwd, run)).toEqual({ found: true, runs: true, signedIn: false, account: null });
  });

  it('says not found when there is no program', async () => {
    expect(await claudeCodeStatus(null, cwd, answering({}).run)).toEqual({ found: false, signedIn: false, account: null });
    // Found but would not start: not a reason to tell the user to sign in.
    expect(await claudeCodeStatus('/nowhere/claude', cwd, answering({ code: null, stderr: 'ENOENT' }).run)).toEqual({ found: true, runs: false, signedIn: false, account: null });
    expect(await claudeCodeStatus('claude', cwd, answering({ code: 127, stderr: 'env: node: No such file or directory' }).run)).toEqual({ found: true, runs: false, signedIn: false, account: null });
  });

  it('does not mistake a number at the end of plain text for an answer', async () => {
    expect(await claudeCodeStatus('claude', cwd, answering({ code: 0, stdout: 'Logged in, version 2' }).run)).toEqual({ found: true, runs: true, signedIn: true, account: null });
  });

  it('falls back to the exit code on an older Claude Code that prints text', async () => {
    expect(await claudeCodeStatus('claude', cwd, answering({ code: 0, stdout: 'Logged in' }).run)).toEqual({ found: true, runs: true, signedIn: true, account: null });
  });
});
