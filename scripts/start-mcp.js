#!/usr/bin/env node
import { existsSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { spawnSync } from 'child_process';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const serverDir = join(root, 'server');
const entry = join(serverDir, 'dist', 'index.js');

function run(command, args) {
  const result = spawnSync(command, args, {
    cwd: serverDir,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });

  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

if (!existsSync(join(serverDir, 'node_modules'))) {
  run('npm', ['install']);
}

if (!existsSync(entry)) {
  run('npm', ['run', 'build']);
}

run('node', [entry]);
