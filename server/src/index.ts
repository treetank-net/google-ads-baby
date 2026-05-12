import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { configFromEnv } from './config.js';
import { registerReadTools } from './tools/read.js';
import { registerWriteTools } from './tools/write.js';

const server = new McpServer({
  name: 'google-ads-baby',
  version: '0.1.0',
});

const cfg = configFromEnv();

registerReadTools(server, cfg);
registerWriteTools(server, cfg);

const transport = new StdioServerTransport();
await server.connect(transport);
