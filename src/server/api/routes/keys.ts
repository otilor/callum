import Anthropic from '@anthropic-ai/sdk';
import { Hono } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { join } from 'node:path';
import { claudeCodeStatus, type ClaudeCodeStatus } from '../../ai/claudeCode.js';
import type { Ctx } from '../../context.js';
import { UserError } from '../../services/errors.js';
import { readBody } from '../http.js';

export interface KeysRoutesOptions {
  /** Asks Claude whether a key works. Throws a UserError when it does not. Tests replace it. */
  verify?: (key: string) => Promise<void>;
  /** Asks Claude Code whether it is signed in. Tests replace it. */
  status?: (path: string | null) => Promise<ClaudeCodeStatus>;
}

/** What Your Callum shows about Claude: where it runs, and whether Claude Code is there and signed in. */
export interface ClaudeInfo {
  engine: 'claude_code' | 'api' | null;
  keySource: 'env' | 'saved' | null;
  claudeCode: ClaudeCodeStatus;
  /** Why the last call to Claude failed, in words, when it did. */
  lastError: string | null;
}

const BROKEN = 'Something went wrong. Callum kept everything as it was.';

/** Asks Anthropic to list its models, which takes no tokens and fails for a key that is not accepted. */
export async function verifyClaudeKey(key: string): Promise<void> {
  try {
    await new Anthropic({ apiKey: key, timeout: 15_000, maxRetries: 0 }).models.list({ limit: 1 });
  } catch (e) {
    if (e instanceof Anthropic.AuthenticationError || e instanceof Anthropic.PermissionDeniedError) {
      throw new UserError("Claude didn't accept that key. Check that you copied all of it.");
    }
    throw new UserError("Callum couldn't reach Claude to check that key. Try again in a moment.");
  }
}

/**
 * Routes under `/api` for the Claude key. It is stored in `channel_secrets` and never returned: the state says only
 * whether Callum has one. A key in the environment (ANTHROPIC_API_KEY) wins over a saved one.
 */
export function keysRoutes(ctx: Ctx, opts: KeysRoutesOptions = {}): Hono {
  const app = new Hono();
  const verify = opts.verify ?? verifyClaudeKey;
  const status = opts.status ?? ((path: string | null) => claudeCodeStatus(path, join(ctx.dataDir, 'claude-code')));

  app.onError((err, c) => {
    if (err instanceof UserError) return c.json({ error: err.message }, err.status as ContentfulStatusCode);
    // Nobody expected this one: the person is told plainly, and the app's own error reporter keeps the details.
    ctx.onError(err);
    return c.json({ error: BROKEN }, 500);
  });

  app.get('/settings/claude', async (c) => {
    // Claude Code may have been installed or signed in since Callum started.
    if (!ctx.demo) ctx.findClaudeCodeAgain();
    const claudeCode = ctx.demo ? { found: false, signedIn: false, account: null } : await status(ctx.claudeCodePath);
    // Signed in since a call failed for want of it: Callum stops waiting, and the old error is not shown beside it.
    if (claudeCode.signedIn && ctx.model?.engine === 'claude_code') ctx.model.signedIn?.();
    const info: ClaudeInfo = {
      engine: ctx.model?.engine ?? null,
      keySource: ctx.claudeKey,
      claudeCode,
      lastError: ctx.model?.lastError ?? null,
    };
    return c.json(info);
  });

  app.post('/settings/claude-key', async (c) => {
    const { key } = await readBody(c);
    const trimmed = typeof key === 'string' ? key.trim() : '';
    if (trimmed === '') throw new UserError('Paste your Claude key first.');
    if (/\s/.test(trimmed)) throw new UserError('A Claude key has no spaces in it. Check that you copied just the key.');
    await verify(trimmed);
    ctx.repo.setChannelSecret('anthropic', { key: trimmed });
    ctx.reloadKeys();
    ctx.bus.emit('settings');
    return c.json({ claudeConnected: ctx.claudeKey !== null });
  });

  app.delete('/settings/claude-key', (c) => {
    ctx.repo.setChannelSecret('anthropic', null);
    ctx.reloadKeys();
    ctx.bus.emit('settings');
    return c.json({ claudeConnected: ctx.claudeKey !== null });
  });

  return app;
}
