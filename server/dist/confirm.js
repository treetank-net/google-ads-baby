import { randomUUID } from 'crypto';
import { mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
export const DEFAULT_TOKEN_TTL_SECONDS = 60 * 60;
function tokenTtlSeconds() {
    const raw = Number(process.env['GOOGLE_ADS_MUTATION_TOKEN_TTL_SECONDS'] || '');
    if (Number.isFinite(raw) && raw > 0)
        return Math.floor(raw);
    switch (process.env['GOOGLE_ADS_SAFETY_LEVEL'] || 'standard') {
        case 'strict':
            return 5 * 60;
        case 'off':
        case 'standard':
        default:
            return DEFAULT_TOKEN_TTL_SECONDS;
    }
}
export function getTokenTtlSeconds() {
    return tokenTtlSeconds();
}
function tokenTtlMs() {
    return tokenTtlSeconds() * 1000;
}
const pending = new Map();
function getConfigDir() {
    return process.env['CLAUDE_PLUGIN_DATA'] || join(process.env['HOME'] || '/tmp', '.google-ads-baby');
}
function getSafeWordPath() {
    return join(getConfigDir(), '.gads-safe-word');
}
function saveSafeWord(word) {
    const dir = getConfigDir();
    mkdirSync(dir, { recursive: true });
    writeFileSync(getSafeWordPath(), word);
}
export function createToken(action, params, preview, safeWord) {
    const token = randomUUID();
    const mutation = { token, action, params, preview, createdAt: Date.now(), safeWord };
    pending.set(token, mutation);
    saveSafeWord(safeWord);
    return mutation;
}
export function consumeToken(token) {
    const mutation = pending.get(token);
    if (!mutation)
        return null;
    pending.delete(token);
    if (Date.now() - mutation.createdAt > tokenTtlMs())
        return null;
    return mutation;
}
export function listPending() {
    const now = Date.now();
    for (const [key, m] of pending) {
        if (now - m.createdAt > tokenTtlMs())
            pending.delete(key);
    }
    return [...pending.values()];
}
//# sourceMappingURL=confirm.js.map