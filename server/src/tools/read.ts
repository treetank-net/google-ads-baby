import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { AdsConfig, listAccounts, executeGaql, getCampaigns } from '../client.js';

export function registerReadTools(server: McpServer, cfg: AdsConfig) {
  server.tool(
    'list_accounts',
    'List all Google Ads accounts under the MCC',
    {},
    async () => {
      const accounts = await listAccounts(cfg);
      return { content: [{ type: 'text', text: JSON.stringify(accounts, null, 2) }] };
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
      const rows = await getCampaigns(cfg, customer_id, Number(days) as 7 | 30);
      return { content: [{ type: 'text', text: JSON.stringify(rows, null, 2) }] };
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
      if (/\b(CREATE|UPDATE|REMOVE|MUTATE)\b/i.test(query)) {
        return { content: [{ type: 'text', text: 'Error: GAQL mutations not allowed via this tool. Use prepare_* tools instead.' }] };
      }
      const rows = await executeGaql(cfg, customer_id, query);
      return { content: [{ type: 'text', text: JSON.stringify(rows, null, 2) }] };
    },
  );
}
