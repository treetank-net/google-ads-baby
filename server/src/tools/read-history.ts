import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AdsConfig } from '../config.js';
import { readHistory, getHistoryStats } from '../history.js';

export function registerHistoryReadTools(server: McpServer, cfg: AdsConfig) {
  server.tool(
    'get_mutation_history',
    'Past mutations from the local audit log.',
    {
      customer_id: z.string().optional(),
      action: z.string().optional().describe('e.g. search_campaign_create'),
      since: z.string().optional().describe('ISO date'),
      until: z.string().optional().describe('ISO date'),
      success_only: z.boolean().optional().default(false),
      limit: z.number().optional().default(20).describe('Default 20, max 200'),
    },
    async ({ customer_id, action, since, until, success_only, limit }) => {
      const entries = readHistory({
        customerId: customer_id,
        action,
        since,
        until,
        successOnly: success_only,
        limit: Math.min(limit ?? 20, 200),
      });
      if (!entries.length) {
        return { content: [{ type: 'text', text: 'No mutation history found matching the filters.' }] };
      }
      const formatted = entries.map((e) => ({
        timestamp: e.timestamp,
        action: e.action,
        customerId: e.customerId,
        success: e.success,
        preview: e.preview,
        params: e.params,
        ...(e.assetIds?.length ? { assetIds: e.assetIds } : {}),
        ...(e.error ? { error: e.error } : {}),
        ...(e.batchId ? { batchId: e.batchId } : {}),
      }));
      return { content: [{ type: 'text', text: JSON.stringify(formatted, null, 2) }] };
    },
  );

  server.tool(
    'get_mutation_stats',
    'Summary of past mutations: counts, success rate, per action, recent asset IDs.',
    {
      customer_id: z.string().optional(),
    },
    async ({ customer_id }) => {
      const stats = getHistoryStats(customer_id);
      if (stats.total === 0) {
        return { content: [{ type: 'text', text: 'No mutation history yet.' }] };
      }
      return { content: [{ type: 'text', text: JSON.stringify(stats, null, 2) }] };
    },
  );
}
