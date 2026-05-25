import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AdsConfig } from '../config.js';
import { registerCampaignPrepareTools } from './write-prepare-campaigns.js';
import { registerAssetPrepareTools } from './write-prepare-assets.js';
import { registerAdPrepareTools } from './write-prepare-ads.js';
import { registerConfirmTools } from './write-confirm.js';

export function registerWriteTools(server: McpServer, cfg: AdsConfig) {
  registerCampaignPrepareTools(server, cfg);
  registerAssetPrepareTools(server, cfg);
  registerAdPrepareTools(server, cfg);
  registerConfirmTools(server, cfg);
}
