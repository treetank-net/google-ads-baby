import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { configFromEnv } from './config.js';
import { registerReadTools } from './tools/read.js';
import { registerWriteTools } from './tools/write.js';
import { registerAuthTools } from './tools/auth.js';
import { withProfile, profileNotice } from './tools/profile.js';
import { PLUGIN_VERSION } from './constants.js';

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
        'Work fast: prefer the composite *_full creation tools over chains of granular prepare_* calls.',
        'To create a Search campaign use prepare_search_campaign_full (budget + campaign + ad groups + keywords + responsive search ads + extensions in ONE atomic transaction and ONE confirmation). Pass a preset (e.g. "ecommerce-search" or "leadgen-search") and only the variable fields; the preset fills match types and bidding. Presets carry no country or language: ask the user which markets the campaign targets and pass locations and languages as ISO codes (locations: ["PL"], languages: ["pl"]). Never assume a market. Do NOT call prepare_search_campaign + prepare_ad_group + prepare_keywords separately for a brand-new campaign.',
        'Similarly prefer prepare_display_campaign_full and prepare_performance_max_campaign_full for whole Display / Performance Max campaigns.',
        'New campaigns are created PAUSED by default. After creation, ask the user whether to enable them.',
      ] : []),
      ...(cfg.toolProfile === 'read' ? [] : [
        'When preparing several changes at once, call the prepare_* tools for all of them first, then ask the user to confirm once, then run confirm_all_mutations with all tokens — a single confirmation covers the whole batch.',
        'Each prepare_* returns a preview and an LLM-invented safe word: show the full preview to the user and ask them to reply with the safe word before calling confirm_mutation / confirm_all_mutations. Never call prepare_* and confirm in the same turn.',
      ]),
      'List-shaped read tools return tab-separated tables and are paginated by response size: the response says which page of how many, and page: N asks for the next slice. Nothing is silently dropped.',
      'Every *_amount field and every amount in a preview or report is in the account currency, never converted — list_accounts shows each account currency, and analysis reports repeat it. Safety caps and diagnostic cost thresholds are scaled to that currency, so the same number means different things on a PLN and a HUF account. Never state an amount in a currency the account does not use.',
    ].join(' '),
  });

  const target = withProfile(server, cfg.toolProfile);

  registerAuthTools(target, cfg);
  registerReadTools(target, cfg);
  registerWriteTools(target, cfg);

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main();
