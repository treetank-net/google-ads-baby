import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AdsConfig } from '../config.js';
import { registerAccountReadTools } from './read-accounts.js';
import { registerHistoryReadTools } from './read-history.js';

export function registerReadTools(server: McpServer, cfg: AdsConfig) {
  registerAccountReadTools(server, cfg);
  registerHistoryReadTools(server, cfg);
}
