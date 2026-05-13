import { startAuthFlow } from '../auth.js';
export function registerAuthTools(server, cfg) {
    server.tool('setup_google_auth', 'Start Google OAuth flow. Returns a URL for the user to click. After authorization the refresh token is saved automatically.', {}, async () => {
        const { url } = startAuthFlow(cfg);
        return {
            content: [{
                    type: 'text',
                    text: 'Opening a browser for Google Ads login. After authorization and configuration in the browser, type anything here.',
                }],
        };
    });
}
//# sourceMappingURL=auth.js.map