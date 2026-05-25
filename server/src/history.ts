import { appendFileSync, mkdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { getConfigDir } from './config.js';

export interface HistoryEntry {
  timestamp: string;
  action: string;
  customerId: string;
  preview: string;
  params: Record<string, unknown>;
  success: boolean;
  error?: string;
  apiResult?: unknown;
  assetIds?: string[];
  batchId?: string;
}

function getHistoryPath(): string {
  return join(getConfigDir(), 'mutation-history.jsonl');
}

export function logMutation(entry: HistoryEntry): void {
  try {
    const dir = getConfigDir();
    mkdirSync(dir, { recursive: true });
    appendFileSync(getHistoryPath(), JSON.stringify(entry) + '\n');
  } catch {}
}

function extractAssetIds(result: unknown): string[] {
  if (!result || typeof result !== 'object') return [];
  const ids: string[] = [];
  const str = JSON.stringify(result);
  const re = /customers\/\d+\/assets\/(\d+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(str)) !== null) ids.push(m[1]);
  return ids;
}

function extractCustomerId(params: Record<string, unknown>): string {
  return String(params.customer_id || params.customerId || '');
}

export function recordSuccess(action: string, params: Record<string, unknown>, preview: string, apiResult: unknown, batchId?: string): void {
  logMutation({
    timestamp: new Date().toISOString(),
    action,
    customerId: extractCustomerId(params),
    preview,
    params,
    success: true,
    apiResult,
    assetIds: extractAssetIds(apiResult),
    batchId,
  });
}

export function recordFailure(action: string, params: Record<string, unknown>, preview: string, error: string, batchId?: string): void {
  logMutation({
    timestamp: new Date().toISOString(),
    action,
    customerId: extractCustomerId(params),
    preview,
    params,
    success: false,
    error,
    batchId,
  });
}

export interface HistoryFilter {
  customerId?: string;
  action?: string;
  since?: string;
  until?: string;
  successOnly?: boolean;
  limit?: number;
}

export function readHistory(filter: HistoryFilter = {}): HistoryEntry[] {
  let lines: string[];
  try {
    lines = readFileSync(getHistoryPath(), 'utf-8').trim().split('\n').filter(Boolean);
  } catch {
    return [];
  }

  let entries: HistoryEntry[] = [];
  for (const line of lines) {
    try { entries.push(JSON.parse(line)); } catch {}
  }

  if (filter.customerId) entries = entries.filter((e) => e.customerId === filter.customerId);
  if (filter.action) entries = entries.filter((e) => e.action === filter.action);
  if (filter.since) entries = entries.filter((e) => e.timestamp >= filter.since!);
  if (filter.until) entries = entries.filter((e) => e.timestamp <= filter.until!);
  if (filter.successOnly) entries = entries.filter((e) => e.success);

  entries.reverse();
  const limit = filter.limit ?? 50;
  return entries.slice(0, limit);
}

export function getHistoryStats(customerId?: string): {
  total: number;
  succeeded: number;
  failed: number;
  byAction: Record<string, number>;
  recentActions: string[];
  usedAssetIds: string[];
} {
  const all = readHistory({ customerId, limit: 10000 });
  const byAction: Record<string, number> = {};
  const assetSet = new Set<string>();
  let succeeded = 0;
  let failed = 0;

  for (const e of all) {
    byAction[e.action] = (byAction[e.action] || 0) + 1;
    if (e.success) succeeded++;
    else failed++;
    for (const id of e.assetIds ?? []) assetSet.add(id);
  }

  const recent = all.slice(0, 10).map((e) => `${e.timestamp} ${e.action} ${e.success ? 'OK' : 'FAIL'}: ${e.preview.split('\n')[0]}`);

  return { total: all.length, succeeded, failed, byAction, recentActions: recent, usedAssetIds: [...assetSet] };
}
