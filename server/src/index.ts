import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { configFromEnv } from './config.js';
import { registerReadTools } from './tools/read.js';
import { registerWriteTools } from './tools/write.js';
import { registerAuthTools } from './tools/auth.js';
import { withProfile, profileNotice } from './tools/profile.js';
import { PLUGIN_VERSION } from './constants.js';
import { compactToolListing } from './tools/compact-listing.js';

async function main() {
  const cfg = await configFromEnv();
  const notice = profileNotice(cfg.toolProfile);
  const server = new McpServer({
    name: 'google-ads-baby',
    version: PLUGIN_VERSION,
  }, {
    instructions: [
      ...(notice ? [notice] : []),
      ...(cfg.toolProfile === 'full' ? [
        'Build new campaigns with the *_full tools (one atomic confirm) instead of chains of granular prepare_* calls; pass a preset and only the variable fields.',
        'Presets carry no market: ask the user which locations and languages to target (ISO codes). New entities are created PAUSED; ask before enabling them.',
      ] : []),
      ...(cfg.toolProfile === 'read' ? [] : [
        'Mutations: every prepare_* takes safe_word (a short random ASCII word you invent, 3-40 chars, no spaces) and returns a preview and token without changing anything.',
        'Show the full preview, ask the user to reply with the safe word, and only then call confirm_mutation or confirm_all_mutations, never in the same turn.',
        'Prepare several changes first and confirm once: reuse one safe word, or fold tokens with prepare_batch. list_pending_mutations, discard_pending_mutations and unfold_batch manage the queue.',
        '*_name and label params next to an id only label the preview.',
      ]),
      'customer_id is the 10-digit account id from list_accounts.',
      'List tools return TSV: money in the account currency, *_pct are percents, "# k=v" header lines hold columns that are constant across rows, and totals cover every matching row even when limit cuts the list.',
      'Ask for less instead of paging through more: fields, order_by (-cost for descending), limit, min_cost/min_impressions/min_clicks, summary: true for totals only. page: N gets the next slice.',
      'Amounts (*_amount fields, previews, reports) are in the account currency shown by list_accounts, never converted, and capped by server safety limits scaled to that currency.',
      'The google-ads-manual skill documents each tool in detail.',
    ].join(' '),
  });

  const target = withProfile(server, cfg.toolProfile);

  registerAuthTools(target, cfg);
  registerReadTools(target, cfg);
  registerWriteTools(target, cfg);
  compactToolListing(server);

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main();
