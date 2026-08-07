import { randomInt, randomUUID } from 'crypto';
import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'fs';
import { join } from 'path';
import { getConfigDir } from './config.js';

export interface PendingMutation {
  token: string;
  action: string;
  params: Record<string, unknown>;
  preview: string;
  createdAt: number;
  safeWord: string;
}

export const BATCH_ACTION = 'batch';

export interface BatchOperation {
  token: string;
  action: string;
  params: Record<string, unknown>;
  preview: string;
}

export const DEFAULT_TOKEN_TTL_SECONDS = 60 * 60;
export const DEFAULT_CONFIRM_STATE_TTL_SECONDS = 60 * 60;

function tokenTtlSeconds(): number {
  const raw = Number(process.env['GOOGLE_ADS_MUTATION_TOKEN_TTL_SECONDS'] || '');
  if (Number.isFinite(raw) && raw > 0) return Math.floor(raw);

  switch (process.env['GOOGLE_ADS_SAFETY_LEVEL'] || 'standard') {
    case 'strict':
      return 5 * 60;
    case 'off':
    case 'standard':
    default:
      return DEFAULT_TOKEN_TTL_SECONDS;
  }
}

function confirmStateTtlSeconds(): number {
  const raw = Number(process.env['GOOGLE_ADS_CONFIRM_STATE_TTL_SECONDS'] || '');
  if (Number.isFinite(raw) && raw > 0) return Math.floor(raw);

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

export function getTokenTtlSeconds(): number {
  return tokenTtlSeconds();
}

function tokenTtlMs(): number {
  return tokenTtlSeconds() * 1000;
}
const pending = new Map<string, PendingMutation>();


function getSafeWordPath(): string {
  return join(getConfigDir(), '.gads-safe-word');
}

function getConfirmStatePath(): string {
  return join(getConfigDir(), '.gads-confirm-state');
}

function saveSafeWord(word: string) {
  const dir = getConfigDir();
  mkdirSync(dir, { recursive: true });
  writeFileSync(getSafeWordPath(), word);
}

export function createToken(action: string, params: Record<string, unknown>, preview: string, safeWord: string): PendingMutation {
  const token = randomUUID();
  const mutation: PendingMutation = { token, action, params, preview, createdAt: Date.now(), safeWord };
  pending.set(token, mutation);
  saveSafeWord(safeWord);
  return mutation;
}

const SAFE_WORD_CONSONANTS = 'bdgklmnprstwz';
const SAFE_WORD_VOWELS = 'aeiouy';

/**
 * A batch's safe word is minted by the server, not invented by the model. The
 * model cannot know it before the batch exists, so it cannot draft a prompt that
 * already contains the word — the user's reply is the only place it can come from.
 */
export function generateSafeWord(syllables = 3): string {
  let word = '';
  for (let i = 0; i < syllables; i += 1) {
    word += SAFE_WORD_CONSONANTS[randomInt(SAFE_WORD_CONSONANTS.length)];
    word += SAFE_WORD_VOWELS[randomInt(SAFE_WORD_VOWELS.length)];
  }
  return word;
}

function batchPreview(operations: BatchOperation[]): string {
  const lines = operations.map((op, index) => `[${index + 1}/${operations.length}] ${op.action}: ${op.preview}`);
  return [
    `Batch of ${operations.length} prepared operation(s), to run in this order:`,
    ...lines,
    'Operations run sequentially and are NOT atomic: an earlier one can succeed while a later one fails.',
  ].join('\n\n');
}

/**
 * Fold already-prepared operations into one batch under a single new safe word.
 *
 * Batching used to be a decision that had to be made before the first
 * `prepare_*`: each call minted its own safe word, and folding an older token
 * into a later confirmation only worked as a side effect of the safe-word file
 * holding the LAST word and the confirmation state being compared against the
 * NEWEST token. Nothing tied the user's reply to the contents of the batch, so
 * an operation whose preview the user saw ten minutes ago (or never, since the
 * pending map is shared by every session on this server process) could ride
 * along. A batch token fixes both: the preview it carries IS the list, and its
 * own safe word is what the user answers.
 */
export function createBatchToken(tokens: string[]):
  | { ok: true; mutation: PendingMutation }
  | { ok: false; error: string } {
  const seen = new Set<string>();
  const operations: BatchOperation[] = [];

  for (const token of tokens) {
    if (seen.has(token)) {
      return { ok: false, error: `Token ${token} was listed twice. Each operation can join a batch once.` };
    }
    seen.add(token);

    const mutation = getPendingToken(token);
    if (!mutation) {
      return { ok: false, error: `Token ${token} is invalid or expired. Prepare that operation again using prepare_*, then batch the fresh tokens.` };
    }
    if (mutation.action === BATCH_ACTION) {
      return { ok: false, error: `Token ${token} is already a batch. Batches do not nest — list the individual operation tokens instead.` };
    }
    operations.push({ token: mutation.token, action: mutation.action, params: mutation.params, preview: mutation.preview });
  }

  // Nothing is consumed until every token validated: a bad token must cost a
  // retry, not the operations that were fine.
  for (const op of operations) pending.delete(op.token);

  return { ok: true, mutation: createToken(BATCH_ACTION, { operations }, batchPreview(operations), generateSafeWord()) };
}

export function consumeToken(token: string): PendingMutation | null {
  const mutation = pending.get(token);
  if (!mutation) return null;
  pending.delete(token);
  if (Date.now() - mutation.createdAt > tokenTtlMs()) return null;
  return mutation;
}

export function getPendingToken(token: string): PendingMutation | null {
  const mutation = pending.get(token);
  if (!mutation) return null;
  if (Date.now() - mutation.createdAt > tokenTtlMs()) {
    pending.delete(token);
    return null;
  }
  return mutation;
}

export function confirmPendingSafeWord(token: string, providedSafeWord: string): { ok: true } | { ok: false; error: string } {
  if (process.env['GOOGLE_ADS_ENABLE_MANUAL_CONFIRM'] !== '1') {
    return {
      ok: false,
      error: 'Manual safe word confirmation is disabled. Set GOOGLE_ADS_ENABLE_MANUAL_CONFIRM=1 only for local testing.',
    };
  }

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

export function consumeConfirmState(mutation: PendingMutation): { ok: true } | { ok: false; error: string } {
  if (process.env['GOOGLE_ADS_SAFETY_LEVEL'] === 'off' || process.env['GOOGLE_ADS_YOLO'] === '1') {
    return { ok: true };
  }

  const statePath = getConfirmStatePath();
  let raw = '';
  try {
    raw = readFileSync(statePath, 'utf-8').trim();
  } catch {
    return { ok: false, error: 'Safe word confirmation is required before confirm_mutation.' };
  }

  const [state, createdAtRaw] = raw.split(':');
  const createdAtSeconds = Number(createdAtRaw || '');
  if (state !== 'user-confirmed' || !Number.isFinite(createdAtSeconds)) {
    return { ok: false, error: 'Safe word confirmation is required before confirm_mutation.' };
  }

  const ttlSeconds = confirmStateTtlSeconds();
  if (ttlSeconds > 0 && Date.now() - createdAtSeconds * 1000 > ttlSeconds * 1000) {
    try { unlinkSync(statePath); } catch {}
    return { ok: false, error: 'Safe word confirmation expired. Prepare the operation again using prepare_*.' };
  }

  if (createdAtSeconds * 1000 + 999 < mutation.createdAt) {
    return { ok: false, error: 'Safe word confirmation predates this operation. Ask the user to confirm the safe word again.' };
  }

  try { unlinkSync(statePath); } catch {}
  return { ok: true };
}

export function listPending(): PendingMutation[] {
  const now = Date.now();
  for (const [key, m] of pending) {
    if (now - m.createdAt > tokenTtlMs()) pending.delete(key);
  }
  return [...pending.values()];
}
