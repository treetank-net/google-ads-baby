#!/usr/bin/env node
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { spawnSync } from 'child_process';

const mode = process.argv[2];
if (!mode) {
  console.error('Usage: google-ads-baby-safety-hook <pre-tool|user-submit>');
  process.exit(2);
}

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const script = join(root, 'scripts', 'safety.sh');
const result = spawnSync(script, [mode], {
  cwd: root,
  stdio: 'inherit',
  shell: false,
});

process.exit(result.status ?? 1);
