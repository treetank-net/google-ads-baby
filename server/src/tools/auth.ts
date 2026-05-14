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
          text: [
            'Opening a browser for Google Ads login.',
            'If no browser window appeared, open this URL manually:',
            url,
            'After authorization and configuration in the browser, type anything here.',
          ].join('\n'),
        }],
      };
    },
  );

}
