import { readFile, writeFile, mkdir } from 'fs/promises';
import { join } from 'path';
import { OAUTH_CLIENT_ID, OAUTH_CLIENT_SECRET } from './constants.js';
function getConfigDir() {
    return process.env['CLAUDE_PLUGIN_DATA'] || join(process.env['HOME'] || '/tmp', '.google-ads-baby');
}
export function getConfigPath() {
    return join(getConfigDir(), 'config.json');
}
export async function loadSavedConfig() {
    try {
        const data = await readFile(getConfigPath(), 'utf-8');
        return JSON.parse(data);
    }
    catch {
        return {};
    }
}
export async function saveConfig(config) {
    const existing = await loadSavedConfig();
    const merged = { ...existing, ...config, savedAt: new Date().toISOString() };
    const dir = getConfigDir();
    await mkdir(dir, { recursive: true });
    const path = getConfigPath();
    await writeFile(path, JSON.stringify(merged, null, 2));
    return path;
}
export async function configFromEnv() {
    const saved = await loadSavedConfig();
    const safetyLevel = process.env['GOOGLE_ADS_SAFETY_LEVEL'] || saved.safetyLevel || 'standard';
    const mutationTokenTtlSeconds = process.env['GOOGLE_ADS_MUTATION_TOKEN_TTL_SECONDS'] || saved.mutationTokenTtlSeconds || '';
    const confirmStateTtlSeconds = process.env['GOOGLE_ADS_CONFIRM_STATE_TTL_SECONDS'] || saved.confirmStateTtlSeconds || '';
    process.env['GOOGLE_ADS_SAFETY_LEVEL'] ||= safetyLevel;
    if (mutationTokenTtlSeconds)
        process.env['GOOGLE_ADS_MUTATION_TOKEN_TTL_SECONDS'] ||= mutationTokenTtlSeconds;
    if (confirmStateTtlSeconds)
        process.env['GOOGLE_ADS_CONFIRM_STATE_TTL_SECONDS'] ||= confirmStateTtlSeconds;
    return {
        clientId: process.env['GOOGLE_ADS_CLIENT_ID'] || saved.clientId || OAUTH_CLIENT_ID,
        clientSecret: process.env['GOOGLE_ADS_CLIENT_SECRET'] || saved.clientSecret || OAUTH_CLIENT_SECRET,
        developerToken: process.env['GOOGLE_ADS_DEVELOPER_TOKEN'] || saved.developerToken || '',
        refreshToken: process.env['GOOGLE_ADS_REFRESH_TOKEN'] || saved.refreshToken || '',
        loginCustomerId: process.env['GOOGLE_ADS_MCC_ID'] || saved.loginCustomerId || '',
        safetyLevel: safetyLevel,
        mutationTokenTtlSeconds,
        confirmStateTtlSeconds,
    };
}
//# sourceMappingURL=config.js.map