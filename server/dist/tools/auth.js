import { startAuthFlow } from '../auth.js';
export function registerAuthTools(server, cfg) {
    server.tool('setup_google_auth', 'Start Google OAuth flow. Returns a URL for the user to click. After authorization the refresh token is saved automatically.', {}, async () => {
        const { url, shortUrl } = startAuthFlow(cfg);
        return {
            content: [{
                    type: 'text',
                    text: [
                        'Opening a browser for Google Ads login.',
                        'If no browser window appeared, open this short local URL manually:',
                        shortUrl,
                        'Direct Google OAuth URL:',
                        url,
                        'After authorization and configuration in the browser, type anything here.',
                    ].join('\n'),
                }],
        };
    });
}
//# sourceMappingURL=auth.js.map