import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { configFromEnv } from './config.js';
import { registerReadTools } from './tools/read.js';
import { registerWriteTools } from './tools/write.js';
import { registerAuthTools } from './tools/auth.js';

async function main() {
  const server = new McpServer({
    name: 'google-ads-baby',
    version: '0.14.0',
  }, {
    instructions: [
      'Work fast: prefer the composite *_full creation tools over chains of granular prepare_* calls.',
      'To create a Search campaign use prepare_search_campaign_full (budget + campaign + ad groups + keywords + responsive search ads + extensions in ONE atomic transaction and ONE confirmation). Pass a preset (e.g. "ecommerce-search-pl" or "leadgen-search-pl") and only the variable fields; the preset fills sane defaults (exact+phrase match, geo PL, language PL, bidding). Do NOT call prepare_search_campaign + prepare_ad_group + prepare_keywords separately for a brand-new campaign.',
      'Similarly prefer prepare_display_campaign_full and prepare_performance_max_campaign_full for whole Display / Performance Max campaigns.',
      'When creating several campaigns at once, call the prepare_* tools for all of them first, then ask the user to confirm once, then run confirm_all_mutations with all tokens — a single confirmation covers the whole batch.',
      'New campaigns are created PAUSED by default. After creation, ask the user whether to enable them.',
      'Each prepare_* returns a preview and an LLM-invented safe word: show the full preview to the user and ask them to reply with the safe word before calling confirm_mutation / confirm_all_mutations. Never call prepare_* and confirm in the same turn.',
    ].join(' '),
  });

  const cfg = await configFromEnv();

  registerAuthTools(server, cfg);
  registerReadTools(server, cfg);
  registerWriteTools(server, cfg);

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main();
