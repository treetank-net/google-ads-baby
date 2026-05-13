import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AdsConfig } from '../config.js';
import { listAccounts, executeGaql, getCampaigns } from '../client.js';
import { formatError } from '../errors.js';
import { normalizeCustomerId, requireCustomerId } from '../validation.js';

export function registerReadTools(server: McpServer, cfg: AdsConfig) {
  server.tool(
    'list_accounts',
    'List all Google Ads accounts under the MCC',
    {},
    async () => {
      if (!cfg.developerToken || !cfg.loginCustomerId) {
        return { content: [{ type: 'text', text: 'Error: Missing developer token or MCC ID. Run setup_google_auth first.' }] };
      }
      try {
        const accounts = await listAccounts(cfg);
        return { content: [{ type: 'text', text: JSON.stringify(accounts, null, 2) }] };
      } catch (err) {
        return { content: [{ type: 'text', text: formatError(err) }] };
      }
    },
  );

  server.tool(
    'get_campaigns',
    'Get campaigns with performance metrics for a specific account',
    {
      customer_id: z.string().describe('Google Ads customer ID (e.g. "1234567890")'),
      days: z.enum(['7', '30']).default('30').describe('Lookback period'),
    },
    async ({ customer_id, days }) => {
      const validationError = requireCustomerId(customer_id);
      if (validationError) {
        return { content: [{ type: 'text', text: `Error: ${validationError}` }] };
      }
      try {
        const rows = await getCampaigns(cfg, normalizeCustomerId(customer_id), Number(days) as 7 | 30);
        return { content: [{ type: 'text', text: JSON.stringify(rows, null, 2) }] };
      } catch (err) {
        return { content: [{ type: 'text', text: formatError(err) }] };
      }
    },
  );

  server.tool(
    'execute_gaql',
    'Run an arbitrary GAQL query against a Google Ads account (read-only)',
    {
      customer_id: z.string().describe('Google Ads customer ID'),
      query: z.string().describe('GAQL query (SELECT ... FROM ... WHERE ...)'),
    },
    async ({ customer_id, query }) => {
      const validationError = requireCustomerId(customer_id);
      if (validationError) {
        return { content: [{ type: 'text', text: `Error: ${validationError}` }] };
      }
      if (/\b(CREATE|UPDATE|REMOVE|MUTATE)\b/i.test(query)) {
        return {
          content: [{ type: 'text', text: 'Error: GAQL mutations not allowed. Use prepare_* tools.' }],
        };
      }
      try {
        const rows = await executeGaql(cfg, normalizeCustomerId(customer_id), query);
        return { content: [{ type: 'text', text: JSON.stringify(rows, null, 2) }] };
      } catch (err) {
        return { content: [{ type: 'text', text: formatError(err) }] };
      }
    },
  );
}
