import { randomUUID } from 'crypto';
import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'fs';
import { join } from 'path';
export const DEFAULT_TOKEN_TTL_SECONDS = 60 * 60;
export const DEFAULT_CONFIRM_STATE_TTL_SECONDS = 60 * 60;
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
function confirmStateTtlSeconds() {
    const raw = Number(process.env['GOOGLE_ADS_CONFIRM_STATE_TTL_SECONDS'] || '');
    if (Number.isFinite(raw) && raw > 0)
        return Math.floor(raw);
    switch (process.env['GOOGLE_ADS_SAFETY_LEVEL'] || 'standard') {
        case 'strict':
            return 5 * 60;
        case 'off':
            return 0;
        case 'standard':
        default:
            return DEFAULT_CONFIRM_STATE_TTL_SECONDS;
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
function getConfirmStatePath() {
    return join(getConfigDir(), '.gads-confirm-state');
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
export function getPendingToken(token) {
    const mutation = pending.get(token);
    if (!mutation)
        return null;
    if (Date.now() - mutation.createdAt > tokenTtlMs()) {
        pending.delete(token);
        return null;
    }
    return mutation;
}
export function confirmPendingSafeWord(token, providedSafeWord) {
    const mutation = getPendingToken(token);
    if (!mutation) {
        return { ok: false, error: 'Token is invalid or expired. Prepare the operation again using prepare_*.' };
    }
    const provided = providedSafeWord.trim();
    if (!provided) {
        return { ok: false, error: 'Missing safe word. Reply with the exact safe word from prepare_*.' };
    }
    const expected = mutation.safeWord.trim();
    if (provided.toLowerCase() !== expected.toLowerCase()) {
        return { ok: false, error: 'Safe word does not match this pending operation.' };
    }
    const dir = getConfigDir();
    mkdirSync(dir, { recursive: true });
    writeFileSync(getConfirmStatePath(), `user-confirmed:${Math.floor(Date.now() / 1000)}`);
    return { ok: true };
}
export function consumeConfirmState(mutation) {
    if (process.env['GOOGLE_ADS_SAFETY_LEVEL'] === 'off' || process.env['GOOGLE_ADS_YOLO'] === '1') {
        return { ok: true };
    }
    const statePath = getConfirmStatePath();
    let raw = '';
    try {
        raw = readFileSync(statePath, 'utf-8').trim();
    }
    catch {
        return { ok: false, error: 'Safe word confirmation is required before confirm_mutation.' };
    }
    const [state, createdAtRaw] = raw.split(':');
    const createdAtSeconds = Number(createdAtRaw || '');
    if (state !== 'user-confirmed' || !Number.isFinite(createdAtSeconds)) {
        return { ok: false, error: 'Safe word confirmation is required before confirm_mutation.' };
    }
    const ttlSeconds = confirmStateTtlSeconds();
    if (ttlSeconds > 0 && Date.now() - createdAtSeconds * 1000 > ttlSeconds * 1000) {
        try {
            unlinkSync(statePath);
        }
        catch { }
        return { ok: false, error: 'Safe word confirmation expired. Prepare the operation again using prepare_*.' };
    }
    if (createdAtSeconds * 1000 + 999 < mutation.createdAt) {
        return { ok: false, error: 'Safe word confirmation predates this operation. Ask the user to confirm the safe word again.' };
    }
    try {
        unlinkSync(statePath);
    }
    catch { }
    return { ok: true };
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