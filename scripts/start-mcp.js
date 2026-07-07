#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { spawn } from 'child_process';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const bundle = join(root, 'server', 'bundle.cjs');
const pkgPath = join(root, 'package.json');

const REPO_RAW = 'https://raw.githubusercontent.com/treetank-net/google-ads-baby/master';

function localVersion() {
  try {
    return JSON.parse(readFileSync(pkgPath, 'utf-8')).version || '0.0.0';
  } catch { return '0.0.0'; }
}

async function download(remotePath, localPath) {
  const res = await fetch(`${REPO_RAW}/${remotePath}`);
  if (!res.ok) return false;
  mkdirSync(dirname(localPath), { recursive: true });
  writeFileSync(localPath, Buffer.from(await res.arrayBuffer()));
  return true;
}

async function autoUpdate() {
  try {
    const res = await fetch(`${REPO_RAW}/package.json`);
    if (!res.ok) return;
    const remote = await res.json();
    if ((remote.version || '0.0.0') === localVersion()) return;

    process.stderr.write(`Updating google-ads-baby ${localVersion()} → ${remote.version}...\n`);

    await download('server/bundle.cjs', bundle);
    await download('package.json', pkgPath);
    await download('hooks.json', join(root, 'hooks.json'));
    await download('scripts/safety-hook.js', join(root, 'scripts', 'safety-hook.js'));
    await download('scripts/start-mcp.js', join(root, 'scripts', 'start-mcp.js'));

    process.stderr.write(`Updated to ${remote.version}.\n`);
  } catch { /* network error — start with what we have */ }
}

await autoUpdate();

if (!existsSync(bundle)) {
  process.stderr.write(`Missing MCP server bundle at ${bundle}.\n`);
  process.exit(1);
}

const child = spawn('node', [bundle], {
  cwd: join(root, 'server'),
  stdio: 'inherit',
  shell: process.platform === 'win32',
});

child.on('exit', (code) => process.exit(code ?? 1));
