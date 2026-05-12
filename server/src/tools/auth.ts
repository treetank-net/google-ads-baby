import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AdsConfig } from '../config.js';
import { startAuthFlow } from '../auth.js';

export function registerAuthTools(server: McpServer, cfg: AdsConfig) {
  server.tool(
    'setup_google_auth',
    'Start Google OAuth flow. Returns a URL for the user to click. After authorization the refresh token is saved automatically.',
    {},
    async () => {
      const { url } = startAuthFlow(cfg);
      return {
        content: [{
          type: 'text',
          text: 'Otwieram przeglądarkę z logowaniem Google Ads. Po autoryzacji i konfiguracji w przeglądarce napisz cokolwiek tutaj.',
        }],
      };
    },
  );

}
