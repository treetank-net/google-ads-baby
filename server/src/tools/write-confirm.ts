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
    'Explain the mutation safety model and hook installation.',
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
    'Test-only: confirm a safe word when GOOGLE_ADS_ENABLE_MANUAL_CONFIRM=1.',
    {
      token: z.string(),
      safe_word: z.string().min(1),
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
    'Execute a prepared mutation or batch after the user replied with its safe word.',
    {
      token: z.string(),
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
    'Fold pending tokens into one batch: one preview, one new server-generated safe word.',
    {
      tokens: z.array(z.string()).min(2).max(50)
        .describe('In run order'),
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
    'Drop pending operations without executing them. Omit tokens to clear all.',
    {
      tokens: z.array(z.string()).min(1).max(50).optional()
        .describe('Omit to clear all'),
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
    'Split a batch back into separate pending operations.',
    {
      token: z.string(),
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
          text: [
            `Unfolded ${result.mutations.length} operations under safe word "${result.mutations[0]?.safeWord}"; the batch token is gone.`,
            ...lines,
          ].join('\n'),
        }],
      };
    },
  );

  server.tool(
    'confirm_all_mutations',
    'Execute several prepared mutations that share one confirmed safe word.',
    {
      tokens: z.array(z.string()).min(1).max(50),
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
    'List pending (unconfirmed) mutations.',
    {},
    async () => {
      const items = listPending();
      if (!items.length) {
        return { content: [{ type: 'text', text: 'No pending operations.' }] };
      }
      const now = Date.now();
      const rows = items.map((item) => [
        item.token,
        item.action,
        item.safeWord,
        `${Math.max(0, Math.round((now - item.createdAt) / 1000))}s`,
        item.preview.split('\n')[0],
      ].join('\t'));
      return { content: [{ type: 'text', text: ['token\taction\tsafe_word\tage\tpreview', ...rows].join('\n') }] };
    },
  );
}
