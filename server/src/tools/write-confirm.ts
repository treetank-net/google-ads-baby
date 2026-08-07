import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AdsConfig } from '../config.js';
import type { PendingMutation } from '../confirm.js';
import {
  confirmPendingSafeWord,
  consumeConfirmState,
  consumeToken,
  createBatchToken,
  discardTokens,
  getPendingToken,
  getTokenTtlSeconds,
  listPending,
  unfoldBatch,
} from '../confirm.js';
import { recordFailure } from '../history.js';
import { CODEX_HOOK_INSTALL_COMMAND } from './write-schemas.js';
import { prepareResponse, safetyHookNotice } from './write-helpers.js';
import { executeMutation, formatMutationError } from './write-executor.js';

export function registerConfirmTools(server: McpServer, cfg: AdsConfig): void {
  server.tool(
    'get_safety_setup',
    'Explain the current mutation safety model and how to install Codex hooks if plugin-local hooks are not active.',
    {},
    async () => ({
      content: [{
        type: 'text',
        text: JSON.stringify({
          safetyLevel: cfg.safetyLevel,
          mutationTokenTtlSeconds: getTokenTtlSeconds(),
          manualSafeWordConfirmation: {
            enabled: process.env['GOOGLE_ADS_ENABLE_MANUAL_CONFIRM'] === '1',
            env: 'GOOGLE_ADS_ENABLE_MANUAL_CONFIRM',
            purpose: 'Test-only fallback for confirm_safe_word. Keep this set to 0/unset outside local testing so normal confirmation relies on user-message hooks.',
          },
          serverSideProtection: 'Every write requires a prepare_* token. Tokens are server-side, one-shot, and time-limited.',
          clientHookGate: safetyHookNotice(cfg),
          codex: {
            expectedProblem: 'Codex may show "No plugin hooks" because current Codex runtime loads MCP from plugins but does not reliably activate plugin-local hooks.',
            fix: 'Install the standalone hook package in addition to the plugin.',
            installCommand: CODEX_HOOK_INSTALL_COMMAND,
            afterInstall: 'Restart or refresh Codex, then verify hooks are visible/active before running confirm_mutation.',
          },
        }, null, 2),
      }],
    }),
  );

  server.tool(
    'confirm_safe_word',
    'Test-only fallback for confirming a safe word when GOOGLE_ADS_ENABLE_MANUAL_CONFIRM=1. Normal use should rely on user-message hooks.',
    {
      token: z.string().describe('Confirmation token from prepare_* response'),
      safe_word: z.string().min(1).describe('Exact safe word shown in prepare_* response'),
    },
    async ({ token, safe_word }) => {
      const result = confirmPendingSafeWord(token, safe_word);
      if (!result.ok) {
        return { content: [{ type: 'text', text: `Error: ${result.error}` }] };
      }
      return { content: [{ type: 'text', text: 'OK: Safe word confirmed for this token. You can now call confirm_mutation.' }] };
    },
  );

  server.tool(
    'confirm_mutation',
    'Execute a previously prepared mutation. Requires a valid, non-expired token from a prepare_* call. The user MUST have explicitly confirmed the action.',
    {
      token: z.string().describe('Confirmation token from prepare_* response'),
    },
    async ({ token }) => {
      const pendingMutation = getPendingToken(token);
      if (!pendingMutation) {
        return {
          content: [{ type: 'text', text: 'Error: Token is invalid or expired. Prepare the operation again using prepare_*.' }],
        };
      }

      const confirmState = consumeConfirmState(pendingMutation);
      if (!confirmState.ok) {
        return {
          content: [{ type: 'text', text: `Error: ${confirmState.error}` }],
        };
      }

      const mutation = consumeToken(token);
      if (!mutation) {
        return {
          content: [{ type: 'text', text: 'Error: Token is invalid or expired. Prepare the operation again using prepare_*.' }],
        };
      }

      try {
        const result = await executeMutation(cfg, mutation);
        return { content: [{ type: 'text', text: result }] };
      } catch (err: any) {
        const errMsg = formatMutationError(err);
        recordFailure(mutation.action, mutation.params as Record<string, any>, mutation.preview, errMsg);
        return { content: [{ type: 'text', text: `Error: ${errMsg}` }] };
      }
    },
  );

  server.tool(
    'prepare_batch',
    'Fold operations you already prepared into ONE batch under a single new safe word. Use it when several prepare_* calls were made separately and the user should confirm them together — including tokens prepared earlier with different safe words. The server mints the batch safe word; show the combined preview and have the user reply with that word, then call confirm_mutation with the batch token. The batched tokens can no longer be confirmed on their own.',
    {
      tokens: z.array(z.string()).min(2).max(50)
        .describe('Tokens from earlier prepare_* calls, in the order they should run. Use list_pending_mutations to see what is still pending.'),
    },
    async ({ tokens }) => {
      const batch = createBatchToken(tokens);
      if (!batch.ok) {
        return { content: [{ type: 'text', text: `Error: ${batch.error}` }] };
      }
      return prepareResponse(cfg, batch.mutation, batch.mutation.preview);
    },
  );

  server.tool(
    'discard_pending_mutations',
    'Drop prepared operations from the queue without executing them. Nothing is sent to Google Ads, so no safe word is needed. Omit tokens to clear the whole queue; pass tokens to drop only those. Discarding a batch token drops the operations inside it too.',
    {
      tokens: z.array(z.string()).min(1).max(50).optional()
        .describe('Tokens to drop. Omit to clear every pending operation.'),
    },
    async ({ tokens }) => {
      const { discarded, missing } = discardTokens(tokens);
      if (!discarded.length) {
        const note = missing.length ? ` Unknown or already-gone tokens: ${missing.join(', ')}.` : '';
        return { content: [{ type: 'text', text: `No pending operations were discarded.${note}` }] };
      }
      const lines = discarded.map((m) => `- ${m.action}: ${m.preview.split('\n')[0]}`);
      const note = missing.length ? `\n\nUnknown or already-gone tokens (nothing to drop): ${missing.join(', ')}.` : '';
      return {
        content: [{
          type: 'text',
          text: `Discarded ${discarded.length} pending operation(s); nothing was sent to Google Ads:\n${lines.join('\n')}${note}`,
        }],
      };
    },
  );

  server.tool(
    'unfold_batch',
    'Take a batch apart into separately confirmable operations again, under one new server-generated safe word. Use it to fix ONE operation inside a batch: unfold, discard_pending_mutations the wrong one, prepare a corrected version, then prepare_batch everything again.',
    {
      token: z.string().describe('Batch token returned by prepare_batch'),
    },
    async ({ token }) => {
      const result = unfoldBatch(token);
      if (!result.ok) {
        return { content: [{ type: 'text', text: `Error: ${result.error}` }] };
      }
      const lines = result.mutations.map((m, i) => `[${i + 1}] token ${m.token} — ${m.action}: ${m.preview.split('\n')[0]}`);
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            unfolded: result.mutations.length,
            safeWord: result.mutations[0]?.safeWord,
            operations: lines,
            instruction: 'These operations are pending separately now. Drop the ones you do not want with discard_pending_mutations, prepare corrected versions if needed, then call prepare_batch again — it mints a fresh safe word for the final list. The batch token is gone.',
          }, null, 2),
        }],
      };
    },
  );

  server.tool(
    'confirm_all_mutations',
    'Execute ALL pending mutations in one batch. Use the same safe_word across multiple prepare_* calls, show combined preview, get one user confirmation, then call this. Requires user confirmation via safe word before calling.',
    {
      tokens: z.array(z.string()).min(1).max(50).describe('Array of confirmation tokens from prepare_* responses'),
    },
    async ({ tokens }) => {
      const validated: PendingMutation[] = [];
      for (const token of tokens) {
        const m = getPendingToken(token);
        if (!m) {
          return { content: [{ type: 'text', text: `Error: Token ${token} is invalid or expired. Prepare the operations again using prepare_*.` }] };
        }
        validated.push(m);
      }

      const latest = validated.reduce((a, b) => a.createdAt > b.createdAt ? a : b);
      const confirmState = consumeConfirmState(latest);
      if (!confirmState.ok) {
        return { content: [{ type: 'text', text: `Error: ${confirmState.error}` }] };
      }

      const batchId = `batch-${Date.now()}`;
      const results: string[] = [];
      let succeeded = 0;
      let failed = 0;
      for (let i = 0; i < tokens.length; i++) {
        const mutation = consumeToken(tokens[i]);
        if (!mutation) {
          results.push(`[${i + 1}/${tokens.length}] Error: Token expired during batch execution.`);
          failed++;
          continue;
        }
        try {
          const result = await executeMutation(cfg, mutation, batchId);
          results.push(`[${i + 1}/${tokens.length}] ${result}`);
          succeeded++;
        } catch (err: any) {
          const errMsg = formatMutationError(err);
          recordFailure(mutation.action, mutation.params as Record<string, any>, mutation.preview, errMsg, batchId);
          results.push(`[${i + 1}/${tokens.length}] Error [${mutation.action}]: ${errMsg}`);
          failed++;
        }
      }

      const summary = `Batch complete: ${succeeded} succeeded, ${failed} failed out of ${tokens.length} operations.`;
      return { content: [{ type: 'text', text: `${summary}\n\n${results.join('\n\n')}` }] };
    },
  );

  server.tool(
    'list_pending_mutations',
    'List all pending (unconfirmed) mutations with their previews and tokens',
    {},
    async () => {
      const items = listPending();
      if (!items.length) {
        return { content: [{ type: 'text', text: 'No pending operations.' }] };
      }
      return { content: [{ type: 'text', text: JSON.stringify(items, null, 2) }] };
    },
  );
}
