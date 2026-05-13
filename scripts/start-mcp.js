#!/usr/bin/env node
import { existsSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { spawnSync } from 'child_process';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const serverDir = join(root, 'server');
const entry = join(serverDir, 'dist', 'index.js');

function runMcpServer() {
  const result = spawnSync('node', [entry], {
    cwd: serverDir,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });

  process.exit(result.status ?? 1);
}

if (!existsSync(entry)) {
  process.stderr.write(`Missing built MCP server at ${entry}. Run "cd server && npm install && npm run build".\n`);
  process.exit(1);
}

runMcpServer();
