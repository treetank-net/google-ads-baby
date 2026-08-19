#!/usr/bin/env node
import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { spawn } from 'child_process';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const bundle = join(root, 'server', 'bundle.cjs');
const pkgPath = join(root, 'package.json');

const REPO_RAW = 'https://raw.githubusercontent.com/treetank-net/google-ads-baby/master';

async function download(remotePath, localPath) {
  const res = await fetch(`${REPO_RAW}/${remotePath}`);
  if (!res.ok) return false;
  const staging = `${localPath}.download`;
  try {
    mkdirSync(dirname(localPath), { recursive: true });
    writeFileSync(staging, Buffer.from(await res.arrayBuffer()));
    renameSync(staging, localPath);
    return true;
  } catch {
    rmSync(staging, { force: true });
    return false;
  }
}

async function fetchRuntimeOnce() {
  process.stderr.write('google-ads-baby: no server bundle on disk, fetching it once...\n');
  try {
    if (!(await download('server/bundle.cjs', bundle))) return;
    if (!existsSync(pkgPath)) await download('package.json', pkgPath);
    for (const relative of ['hooks.json', 'scripts/safety-hook.js']) {
      const target = join(root, relative);
      if (!existsSync(target)) await download(relative, target);
    }
    process.stderr.write('google-ads-baby: bundle fetched.\n');
  } catch { /* offline — handled by the existence check below */ }
}

if (!existsSync(bundle)) await fetchRuntimeOnce();

if (!existsSync(bundle)) {
  process.stderr.write(`Missing MCP server bundle at ${bundle} and it could not be fetched. Reinstall the plugin.\n`);
  process.exit(1);
}

const child = spawn('node', [bundle], {
  cwd: join(root, 'server'),
  stdio: 'inherit',
  shell: process.platform === 'win32',
});

child.on('exit', (code) => process.exit(code ?? 1));
