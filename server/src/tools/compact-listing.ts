import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const VALIDATION_ONLY_KEYS = new Set(['$schema', 'additionalProperties', 'pattern', 'exclusiveMinimum']);

export function compactSchema(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(compactSchema);
  if (!value || typeof value !== 'object') return value;
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (key === 'properties' && item && typeof item === 'object') {
      out[key] = Object.fromEntries(Object.entries(item as Record<string, unknown>).map(([name, schema]) => [name, compactSchema(schema)]));
      continue;
    }
    if (VALIDATION_ONLY_KEYS.has(key)) continue;
    if (key === 'minLength' && item === 1) continue;
    out[key] = compactSchema(item);
  }
  return out;
}

export interface ListedTool {
  name: string;
  inputSchema?: unknown;
  execution?: { taskSupport?: string };
  [key: string]: unknown;
}

export function compactTool(tool: ListedTool): ListedTool {
  const { execution, inputSchema, ...rest } = tool;
  const compacted: ListedTool = { ...rest, inputSchema: compactSchema(inputSchema) };
  if (execution && execution.taskSupport !== 'forbidden') compacted.execution = execution;
  return compacted;
}

type Handler = (request: unknown, extra: unknown) => Promise<{ tools: ListedTool[] }>;

export function compactToolListing(server: McpServer): void {
  const handlers = (server.server as unknown as { _requestHandlers: Map<string, Handler> })._requestHandlers;
  const listTools = handlers.get('tools/list');
  if (!listTools) return;
  server.server.setRequestHandler(ListToolsRequestSchema, async (request, extra) => {
    const listing = await listTools(request, extra);
    return { ...listing, tools: listing.tools.map(compactTool) } as never;
  });
}
