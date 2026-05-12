import { randomUUID } from 'crypto';

export interface PendingMutation {
  token: string;
  action: string;
  params: Record<string, unknown>;
  preview: string;
  createdAt: number;
}

const TOKEN_TTL_MS = 60_000;
const pending = new Map<string, PendingMutation>();

export function createToken(action: string, params: Record<string, unknown>, preview: string): PendingMutation {
  const token = randomUUID();
  const mutation: PendingMutation = { token, action, params, preview, createdAt: Date.now() };
  pending.set(token, mutation);
  return mutation;
}

export function consumeToken(token: string): PendingMutation | null {
  const mutation = pending.get(token);
  if (!mutation) return null;
  pending.delete(token);
  if (Date.now() - mutation.createdAt > TOKEN_TTL_MS) return null;
  return mutation;
}

export function listPending(): PendingMutation[] {
  const now = Date.now();
  for (const [key, m] of pending) {
    if (now - m.createdAt > TOKEN_TTL_MS) pending.delete(key);
  }
  return [...pending.values()];
}
