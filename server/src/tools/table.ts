import { z } from 'zod';
import { enums, fields } from 'google-ads-api';
import { decodeCell, flattenRow, shortenResourceName } from './format.js';

export type Cell = string | number | boolean | null | undefined;
export type Row = Record<string, Cell>;

export const DEFAULT_TABLE_PAGE_CHARS = 12_000;
export const MIN_TABLE_PAGE_CHARS = 2_000;
export const MAX_TABLE_PAGE_CHARS = 100_000;

const COLUMN_ALIASES: Record<string, string> = {
  'campaign.name': 'campaign',
  'ad_group.name': 'ad_group',
  'asset_group.name': 'asset_group',
  'customer.descriptive_name': 'account',
  'campaign.advertising_channel_type': 'channel',
  'campaign.advertising_channel_sub_type': 'channel_subtype',
  'campaign.bidding_strategy_type': 'bidding',
  'campaign_budget.amount_micros': 'budget',
  'ad_group_criterion.keyword.text': 'keyword',
  'ad_group_criterion.keyword.match_type': 'match_type',
  'campaign_criterion.keyword.text': 'keyword',
  'campaign_criterion.keyword.match_type': 'match_type',
  'search_term_view.search_term': 'search_term',
  'ad_group.campaign': 'campaign_id',
  'ad_group_ad.ad_group': 'ad_group_id',
  'ad_group_ad.ad.id': 'ad_id',
  'ad_group_ad.ad.type': 'ad_type',
  'ad_group_ad.ad.name': 'ad_name',
  'ad_group_ad.status': 'ad_status',
  'metrics.cost_micros': 'cost',
  'metrics.conversions_value': 'conv_value',
  'metrics.all_conversions_value': 'all_conv_value',
  'metrics.cost_per_conversion': 'cpa',
  'metrics.average_cpc': 'avg_cpc',
  'metrics.average_cpm': 'avg_cpm',
  'metrics.average_cost': 'avg_cost',
  'metrics.search_impression_share': 'search_is_pct',
  'metrics.search_budget_lost_impression_share': 'search_lost_is_budget_pct',
  'metrics.search_rank_lost_impression_share': 'search_lost_is_rank_pct',
};

const GENERIC_LEAVES = new Set(['id', 'name', 'status', 'type', 'text', 'amount', 'resource_name', 'serving_status']);
const UNPREFIXED_ROOTS = new Set(['metrics', 'segments']);
const MICROS_LEAVES = new Set([
  'average_cpc', 'average_cpm', 'average_cpe', 'average_cpv', 'average_cost',
  'cost_per_conversion', 'cost_per_all_conversions', 'cost_per_current_model_attributed_conversion',
]);
export const SUMMABLE_COLUMNS = new Set([
  'impressions', 'clicks', 'cost', 'conversions', 'conv_value', 'all_conversions', 'all_conv_value',
  'interactions', 'video_views', 'engagements',
]);

type EnumTable = Record<string | number, string | number>;
const ENUM_FIELDS = (fields as unknown as { enumFields: Record<string, string> }).enumFields;
const ENUM_TABLES = enums as unknown as Record<string, EnumTable>;

function leafOf(path: string): string {
  const segments = path.split('.');
  return segments[segments.length - 1];
}

function isMicros(path: string): boolean {
  const leaf = leafOf(path);
  return leaf.endsWith('_micros') || (path.startsWith('metrics.') && MICROS_LEAVES.has(leaf));
}

function isPercent(path: string): boolean {
  if (!path.startsWith('metrics.')) return false;
  const leaf = leafOf(path);
  return leaf === 'ctr' || leaf.endsWith('_rate') || leaf.endsWith('impression_share') || leaf.endsWith('_percentage');
}

export function columnName(path: string): string {
  const alias = COLUMN_ALIASES[path];
  if (alias) return alias;
  const segments = path.split('.');
  if (segments.length > 1 && UNPREFIXED_ROOTS.has(segments[0])) segments.shift();
  let leaf = segments[segments.length - 1].replace(/_micros$/, '');
  if (isPercent(path)) leaf = `${leaf.replace(/_percentage$/, '')}_pct`;
  if (segments.length > 1 && GENERIC_LEAVES.has(segments[segments.length - 1])) {
    const parent = segments[segments.length - 2];
    return leaf === 'name' ? parent : `${parent}_${leaf}`;
  }
  return leaf;
}

function roundTo(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

function significant(value: number): number {
  if (Number.isInteger(value) || !Number.isFinite(value)) return value;
  return Math.abs(value) >= 1 ? roundTo(value, 2) : Number(value.toPrecision(3));
}

function decodeEnum(path: string, value: unknown): unknown {
  const enumName = ENUM_FIELDS[path];
  if (!enumName) return decodeCell(path, value);
  if (typeof value !== 'number' && !(typeof value === 'string' && /^\d+$/.test(value))) return value;
  const name = ENUM_TABLES[enumName]?.[value as keyof EnumTable];
  return typeof name === 'string' ? name : `UNKNOWN(${value})`;
}

export function convertValue(path: string, value: unknown): Cell {
  if (value === undefined || value === null || value === '') return undefined;
  const decoded = shortenResourceName(decodeEnum(path, value));
  const numeric = typeof decoded === 'number' ? decoded : (typeof decoded === 'string' && /^-?\d+(\.\d+)?$/.test(decoded) && (isMicros(path) || isPercent(path)) ? Number(decoded) : undefined);
  if (numeric !== undefined) {
    if (isMicros(path)) return roundTo(numeric / 1_000_000, 2);
    if (isPercent(path)) return roundTo(numeric * 100, 2);
    return significant(numeric);
  }
  return decoded as Cell;
}

export function normalizeRows(raw: unknown[]): Row[] {
  const names = new Map<string, string>();
  const taken = new Map<string, string>();
  const nameFor = (path: string): string => {
    const known = names.get(path);
    if (known) return known;
    let name = columnName(path);
    const owner = taken.get(name);
    if (owner && owner !== path) name = path.replace(/\./g, '_');
    taken.set(name, path);
    names.set(path, name);
    return name;
  };
  return raw.map((item) => {
    const flat = flattenRow(item);
    const row: Row = {};
    for (const [path, value] of Object.entries(flat)) {
      const cell = convertValue(path, value);
      if (cell !== undefined) row[nameFor(path)] = cell;
    }
    return row;
  });
}

export const shapeSchemas = {
  fields: z.array(z.string()).optional().describe('Columns to return'),
  order_by: z.string().optional().describe('Column to sort by; prefix - for descending, e.g. -cost'),
  limit: z.number().int().positive().optional().describe('Top-N rows after filtering and sorting'),
  min_cost: z.number().optional(),
  min_impressions: z.number().optional(),
  min_clicks: z.number().optional(),
  summary: z.boolean().optional().describe('Totals and row count only'),
  page: z.number().int().positive().optional(),
  page_chars: z.number().int().min(MIN_TABLE_PAGE_CHARS).max(MAX_TABLE_PAGE_CHARS).optional(),
};

export interface Shape {
  fields?: string[];
  order_by?: string;
  limit?: number;
  min_cost?: number;
  min_impressions?: number;
  min_clicks?: number;
  summary?: boolean;
  page?: number;
  page_chars?: number;
}

export interface Shaped {
  rows: Row[];
  total: number;
  matched: number;
  totals: Row;
  columns: string[];
  notes: string[];
}

export class ShapeError extends Error {}

function columnsOf(rows: Row[]): string[] {
  const columns: string[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    for (const key of Object.keys(row)) {
      if (!seen.has(key)) {
        seen.add(key);
        columns.push(key);
      }
    }
  }
  return columns;
}

function requireColumn(column: string, available: string[], param: string): void {
  if (!available.includes(column)) {
    throw new ShapeError(`${param}: unknown column "${column}". Available: ${available.join(', ')}`);
  }
}

function compareCells(a: Cell, b: Cell, descending: boolean): number {
  const aEmpty = a === undefined || a === null || a === '';
  const bEmpty = b === undefined || b === null || b === '';
  if (aEmpty || bEmpty) return aEmpty === bEmpty ? 0 : aEmpty ? 1 : -1;
  const result = typeof a === 'number' && typeof b === 'number' ? a - b : String(a).localeCompare(String(b));
  return descending ? -result : result;
}

export function sumColumns(rows: Row[], columns: string[]): Row {
  const totals: Row = {};
  for (const column of columns) {
    if (!SUMMABLE_COLUMNS.has(column)) continue;
    let sum = 0;
    for (const row of rows) {
      const value = row[column];
      if (typeof value === 'number') sum += value;
    }
    totals[column] = column === 'cost' || column.endsWith('_value') ? roundTo(sum, 2) : significant(roundTo(sum, 4));
  }
  return totals;
}

export function shapeRows(all: Row[], shape: Shape, defaultOrder?: string): Shaped {
  const available = columnsOf(all);
  const notes: string[] = [];
  let rows = all;

  const thresholds: Array<[string, number | undefined]> = [
    ['cost', shape.min_cost],
    ['impressions', shape.min_impressions],
    ['clicks', shape.min_clicks],
  ];
  for (const [column, minimum] of thresholds) {
    if (minimum === undefined) continue;
    if (all.length) requireColumn(column, available, `min_${column}`);
    rows = rows.filter((row) => typeof row[column] === 'number' && (row[column] as number) >= minimum);
    notes.push(`min_${column}=${minimum}`);
  }
  const matched = rows.length;

  const order = shape.order_by ?? defaultOrder;
  if (order) {
    const descending = order.startsWith('-');
    const column = descending ? order.slice(1) : order;
    if (all.length) requireColumn(column, available, 'order_by');
    rows = [...rows].sort((a, b) => compareCells(a[column], b[column], descending));
  }

  const totals = sumColumns(rows, available);

  if (shape.limit !== undefined && rows.length > shape.limit) {
    rows = rows.slice(0, shape.limit);
    notes.push(`showing top ${shape.limit} of ${matched}${order ? ` by ${order}` : ''}`);
  } else if (order) {
    notes.push(`by ${order}`);
  }

  let columns = available;
  if (shape.fields?.length) {
    for (const field of shape.fields) requireColumn(field, available, 'fields');
    columns = shape.fields;
    rows = rows.map((row) => Object.fromEntries(columns.filter((c) => c in row).map((c) => [c, row[c]])));
  }

  return { rows, total: all.length, matched, totals, columns, notes };
}

function escapeCell(value: Cell): string {
  if (value === undefined || value === null) return '';
  return String(value).replace(/[\t\r\n]+/g, ' ');
}

export interface Layout {
  columns: string[];
  constants: Row;
}

export function layoutFor(rows: Row[], columns: string[]): Layout {
  const present = columns.filter((column) => rows.some((row) => row[column] !== undefined && row[column] !== ''));
  const constants: Row = {};
  if (rows.length < 2) return { columns: present, constants };
  const varying = present.filter((column) => {
    const first = rows[0][column];
    const constant = first !== undefined && rows.every((row) => row[column] === first);
    if (constant) constants[column] = first;
    return !constant;
  });
  return { columns: varying.length ? varying : present, constants: varying.length ? constants : {} };
}

export function renderRows(rows: Row[], columns: string[]): string {
  if (!columns.length || !rows.length) return '';
  return [columns.join('\t'), ...rows.map((row) => columns.map((column) => escapeCell(row[column])).join('\t'))].join('\n');
}

function formatPairs(row: Row): string {
  return Object.entries(row).map(([key, value]) => `${key}=${escapeCell(value)}`).join(' ');
}

function pageRows(rows: Row[], columns: string[], page: number, maxChars: number): { rows: Row[]; page: number; pages: number; from: number } {
  if (!rows.length) return { rows, page: 1, pages: 1, from: 0 };
  const full = renderRows(rows, columns).length;
  let perPage = rows.length;
  if (full > maxChars) {
    const header = columns.join('\t').length + 1;
    const perRow = Math.max(1, (full - header) / rows.length);
    perPage = Math.max(1, Math.floor((maxChars - header) / perRow));
  }
  const pages = Math.ceil(rows.length / perPage);
  const current = Math.min(Math.max(1, Math.floor(page) || 1), pages);
  const start = (current - 1) * perPage;
  return { rows: rows.slice(start, start + perPage), page: current, pages, from: start + 1 };
}

export interface TableSpec {
  title: string;
  scope?: string[];
  currency?: string;
  rows: Row[];
  shape?: Shape;
  defaultOrder?: string;
  extraNotes?: string[];
}

export function tableDocument(spec: TableSpec): string {
  const shape = spec.shape ?? {};
  const shaped = shapeRows(spec.rows, shape, spec.defaultOrder);
  const layout = layoutFor(shaped.rows, shaped.columns);
  const rowCount = shaped.notes.some((note) => note.startsWith('showing')) ? [] : [`rows=${shaped.rows.length}`];
  const filtered = shaped.matched !== shaped.total ? [`${shaped.matched} of ${shaped.total} match`] : [];
  const head = [spec.title, ...(spec.scope ?? []), ...(spec.currency ? [`currency=${spec.currency}`] : []), ...rowCount, ...filtered, ...shaped.notes];
  const lines = [`# ${head.join(' · ')}`];
  if (Object.keys(layout.constants).length) lines.push(`# ${formatPairs(layout.constants)}`);
  if (Object.keys(shaped.totals).length && (shaped.matched > 1 || shape.summary)) {
    lines.push(`# totals${shaped.matched !== shaped.rows.length ? ` (all ${shaped.matched})` : ''}: ${formatPairs(shaped.totals)}`);
  }
  for (const note of spec.extraNotes ?? []) lines.push(`# ${note}`);
  if (shape.summary) return lines.join('\n');

  const paged = pageRows(shaped.rows, layout.columns, shape.page ?? 1, shape.page_chars ?? DEFAULT_TABLE_PAGE_CHARS);
  const body = renderRows(paged.rows, layout.columns);
  if (body) lines.push(body);
  if (paged.pages > 1) {
    const to = paged.from + paged.rows.length - 1;
    lines.push(`# page ${paged.page}/${paged.pages}, rows ${paged.from}-${to} of ${shaped.rows.length}${paged.page < paged.pages ? `; page: ${paged.page + 1} for more` : ''}`);
  }
  return lines.join('\n');
}

export function tableError(err: unknown): string | undefined {
  return err instanceof ShapeError ? `Error: ${err.message}` : undefined;
}
