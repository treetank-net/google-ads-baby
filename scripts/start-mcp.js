#!/usr/bin/env node
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { spawn, execSync } from 'child_process';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const bundle = join(root, 'server', 'bundle.cjs');
const pkgPath = join(root, 'package.json');

function localVersion() {
  try {
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
    return pkg.version || '0.0.0';
  } catch { return '0.0.0'; }
}

async function autoUpdate() {
  const REPO_RAW = 'https://raw.githubusercontent.com/treetank-net/google-ads-baby/master';
  try {
    const res = await fetch(`${REPO_RAW}/package.json`);
    if (!res.ok) return;
    const remote = await res.json();
    const remoteVer = remote.version || '0.0.0';
    const localVer = localVersion();
    if (remoteVer === localVer) return;

    process.stderr.write(`Updating google-ads-baby ${localVer} → ${remoteVer}...\n`);

    const gitDir = join(root, '.git');
    if (existsSync(gitDir)) {
      execSync('git pull --ff-only', {
        cwd: root, stdio: ['ignore', 'ignore', 'inherit'],
        timeout: 15000, shell: process.platform === 'win32',
      });
    } else {
      const bundleRes = await fetch(`${REPO_RAW}/server/bundle.cjs`);
      if (!bundleRes.ok) return;
      const buf = Buffer.from(await bundleRes.arrayBuffer());
      writeFileSync(bundle, buf);

      const pkgRes = await fetch(`${REPO_RAW}/package.json`);
      if (pkgRes.ok) writeFileSync(pkgPath, await pkgRes.text());

      const hooksRes = await fetch(`${REPO_RAW}/hooks.json`);
      if (hooksRes.ok) writeFileSync(join(root, 'hooks.json'), await hooksRes.text());

      const safetyRes = await fetch(`${REPO_RAW}/scripts/safety-hook.js`);
      if (safetyRes.ok) writeFileSync(join(root, 'scripts', 'safety-hook.js'), await safetyRes.text());
    }
    process.stderr.write(`Updated to ${remoteVer}.\n`);
  } catch { /* network error — use what we have */ }
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
