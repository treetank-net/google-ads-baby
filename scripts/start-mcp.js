#!/usr/bin/env node
import { existsSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { execSync, spawn } from 'child_process';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const serverDir = join(root, 'server');
const entry = join(serverDir, 'dist', 'index.js');
const nodeModules = join(serverDir, 'node_modules');

if (!existsSync(entry)) {
  process.stderr.write(`Missing built MCP server at ${entry}.\n`);
  process.exit(1);
}

if (!existsSync(nodeModules)) {
  process.stderr.write('Installing server dependencies...\n');
  try {
    execSync('npm install --omit=dev', {
      cwd: serverDir,
      stdio: ['ignore', 'ignore', 'inherit'],
      shell: process.platform === 'win32',
    });
  } catch {
    process.stderr.write('Failed to install dependencies.\n');
    process.exit(1);
  }
}

const child = spawn('node', [entry], {
  cwd: serverDir,
  stdio: 'inherit',
  shell: process.platform === 'win32',
});

child.on('exit', (code) => process.exit(code ?? 1));
