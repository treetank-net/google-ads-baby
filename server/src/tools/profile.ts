import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

export type ToolProfile = 'read' | 'manage' | 'full';

const PROFILE_RANK: Record<ToolProfile, number> = { read: 0, manage: 1, full: 2 };

export const TOOL_PROFILE: Record<string, ToolProfile> = {
  setup_google_auth: 'read',
  update_plugin: 'read',
  list_accounts: 'read',
  get_campaigns: 'read',
  execute_gaql: 'read',
  list_ads_entities: 'read',
  get_ad_blueprint: 'read',
  get_build_context: 'read',
  get_account_hygiene_report: 'read',
  get_budget_scaling_candidates: 'read',
  get_search_terms_waste_candidates: 'read',
  get_pmax_channel_breakdown: 'read',
  get_display_remarketing_diagnostics: 'read',
  get_mutation_history: 'read',
  get_mutation_stats: 'read',

  get_safety_setup: 'manage',
  confirm_safe_word: 'manage',
  confirm_mutation: 'manage',
  confirm_all_mutations: 'manage',
  prepare_campaign_status: 'manage',
  prepare_campaign_update: 'manage',
  prepare_budget_change: 'manage',
  prepare_bidding_strategy: 'manage',
  prepare_ad_group_update: 'manage',
  prepare_ad_update: 'manage',
  prepare_ad_status: 'manage',
  prepare_keyword_status: 'manage',
  prepare_keywords: 'manage',
  prepare_negative_keywords: 'manage',
  prepare_campaign_targeting: 'manage',
  prepare_demographic_bid_modifier: 'manage',
  prepare_campaign_conversion_goals: 'manage',
  prepare_campaign_shared_set: 'manage',
  prepare_ad_schedule: 'manage',
  prepare_negative_topics: 'manage',
  prepare_remove_ad_group_criterion: 'manage',
  prepare_campaign_removal: 'manage',
  list_pending_mutations: 'manage',

  prepare_search_campaign: 'full',
  prepare_display_campaign: 'full',
  prepare_performance_max_campaign: 'full',
  prepare_search_campaign_full: 'full',
  prepare_display_campaign_full: 'full',
  prepare_performance_max_campaign_full: 'full',
  prepare_ad_group: 'full',
  prepare_display_ad_group: 'full',
  prepare_responsive_search_ad: 'full',
  prepare_responsive_display_ad: 'full',
  prepare_clone_entity: 'full',
  prepare_asset_group: 'full',
  prepare_asset_group_signals: 'full',
  prepare_asset_group_listing_groups: 'full',
  prepare_image_asset_from_file: 'full',
  prepare_image_asset_from_url: 'full',
  prepare_sitelink_assets: 'full',
  prepare_callout_assets: 'full',
  prepare_call_asset: 'full',
  prepare_structured_snippet_assets: 'full',
  prepare_campaign_extensions: 'full',
  prepare_campaign_assets: 'full',
  prepare_ad_group_assets: 'full',
  prepare_asset_group_assets: 'full',
};

export function normalizeProfile(value: string | undefined): ToolProfile {
  const lowered = (value ?? '').trim().toLowerCase();
  return lowered === 'read' || lowered === 'manage' ? lowered : 'full';
}

export function isToolAllowed(name: string, profile: ToolProfile): boolean {
  const required = TOOL_PROFILE[name];
  if (!required) return true;
  return PROFILE_RANK[required] <= PROFILE_RANK[profile];
}

export function profileNotice(profile: ToolProfile): string {
  if (profile === 'read') {
    return 'GOOGLE_ADS_BABY_PROFILE=read: this server exposes read and diagnostic tools only. No prepare_*/confirm_* tools are registered, so mutations are impossible in this session — do not look for another way to change the account. Tell the user to set GOOGLE_ADS_BABY_PROFILE=manage (edits to existing entities) or full (creation, assets, composite builders) and restart the MCP server.';
  }
  if (profile === 'manage') {
    return 'GOOGLE_ADS_BABY_PROFILE=manage: budget, bid, status and text edits to existing entities are available; campaign/ad-group/ad creation, asset tools, cloning and the composite *_full builders are not registered. If the user asks to create something, say the profile excludes it and that GOOGLE_ADS_BABY_PROFILE=full plus an MCP restart enables it — do not improvise a workaround.';
  }
  return '';
}

export function withProfile(server: McpServer, profile: ToolProfile): McpServer {
  if (profile === 'full') return server;
  const register = server.tool.bind(server);
  const gated = (...args: unknown[]) => {
    const name = args[0] as string;
    if (!isToolAllowed(name, profile)) return undefined as never;
    return (register as (...a: unknown[]) => never)(...args);
  };
  return new Proxy(server, {
    get(target, property, receiver) {
      if (property === 'tool') return gated;
      return Reflect.get(target, property, receiver);
    },
  }) as McpServer;
}
