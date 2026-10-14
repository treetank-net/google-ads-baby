import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { readFileSync, renameSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import type { AdsConfig } from '../config.js';
import { startAuthFlow } from '../auth.js';
import { PLUGIN_VERSION } from '../constants.js';

const REPO_RAW = 'https://raw.githubusercontent.com/treetank-net/google-ads-baby/master';

function getPluginRoot(): string {
  return process.env['CLAUDE_PLUGIN_ROOT'] || process.cwd();
}

function getInstalledVersion(): string {
  try {
    const pkgPath = join(getPluginRoot(), 'package.json');
    return JSON.parse(readFileSync(pkgPath, 'utf-8')).version || '0.0.0';
  } catch { return '0.0.0'; }
}

async function downloadFile(remotePath: string, localPath: string): Promise<boolean> {
  const res = await fetch(`${REPO_RAW}/${remotePath}`);
  if (!res.ok) return false;
  const staging = `${localPath}.download`;
  try {
    writeFileSync(staging, Buffer.from(await res.arrayBuffer()));
    renameSync(staging, localPath);
    return true;
  } catch {
    rmSync(staging, { force: true });
    return false;
  }
}

function restartPendingNote(installedVer: string): string {
  return [
    `Installed on disk: ${installedVer} — running: ${PLUGIN_VERSION}.`,
    'Restart the session: the running server holds its bundle in memory and cannot swap it while serving this call.',
  ].join(' ');
}

function parseSemver(v: string): number[] {
  return v.replace(/^v/, '').split('.').map((n) => parseInt(n, 10) || 0);
}

function semverGt(a: string, b: string): boolean {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const da = pa[i] || 0;
    const db = pb[i] || 0;
    if (da !== db) return da > db;
  }
  return false;
}

function extractChangelog(text: string, fromVer: string, toVer: string): string {
  const lines = text.split('\n');
  const sections: string[] = [];
  let current: { version: string; body: string[] } | null = null;
  const flush = () => {
    if (current && semverGt(current.version, fromVer) && !semverGt(current.version, toVer)) {
      sections.push([`## ${current.version}`, ...current.body].join('\n').trimEnd());
    }
  };
  for (const line of lines) {
    const m = line.match(/^##\s+v?(\d+\.\d+\.\d+)/);
    if (m) {
      flush();
      current = { version: m[1], body: [] };
    } else if (current) {
      current.body.push(line);
    }
  }
  flush();
  return sections.join('\n\n').trim();
}

async function fetchChangelog(fromVer: string, toVer: string): Promise<string> {
  try {
    const res = await fetch(`${REPO_RAW}/CHANGELOG.md`);
    if (!res.ok) return '';
    return extractChangelog(await res.text(), fromVer, toVer);
  } catch { return ''; }
}

export function registerAuthTools(server: McpServer, cfg: AdsConfig) {
  server.tool(
    'setup_google_auth',
    'Start Google OAuth; returns a URL for the user. The token is saved automatically.',
    {},
    async () => {
      const { shortUrl } = startAuthFlow(cfg);
      return {
        content: [{
          type: 'text',
          text: [
            'Opening a browser for Google Ads setup.',
            'If no browser window appeared, open this URL manually:',
            shortUrl,
            'After authorization and configuration in the browser, type anything here.',
          ].join('\n'),
        }],
      };
    },
  );

  server.tool(
    'update_plugin',
    'Check for and download plugin updates. Takes effect after a session restart.',
    {},
    async () => {
      const installedVer = getInstalledVersion();
      try {
        const res = await fetch(`${REPO_RAW}/package.json`);
        if (!res.ok) {
          return { content: [{ type: 'text', text: `Cannot reach update server. ${restartPendingNote(installedVer)}` }] };
        }
        const remote = await res.json() as { version?: string };
        const remoteVer = remote.version || '0.0.0';

        if (!semverGt(remoteVer, installedVer)) {
          const text = remoteVer === installedVer
            ? (PLUGIN_VERSION === installedVer
                ? `Already up to date and active: ${PLUGIN_VERSION}.`
                : `Already downloaded, not yet active. ${restartPendingNote(installedVer)}`)
            : `Nothing to install: this copy is ${installedVer}, newer than ${remoteVer} on the update server. Local files left untouched.`;
          return { content: [{ type: 'text', text }] };
        }

        const root = getPluginRoot();
        const results: string[] = [];
        const changelog = await fetchChangelog(installedVer, remoteVer);

        const files = [
          ['server/bundle.cjs', join(root, 'server', 'bundle.cjs')],
          ['package.json', join(root, 'package.json')],
          ['hooks.json', join(root, 'hooks.json')],
          ['scripts/safety-hook.js', join(root, 'scripts', 'safety-hook.js')],
          ['scripts/start-mcp.js', join(root, 'scripts', 'start-mcp.js')],
          ['CHANGELOG.md', join(root, 'CHANGELOG.md')],
        ];
        for (const [remote, local] of files) {
          const ok = await downloadFile(remote, local);
          results.push(`${remote}: ${ok ? 'OK' : 'FAILED'}`);
        }

        return {
          content: [{
            type: 'text',
            text: [
              `Downloaded ${installedVer} → ${remoteVer}`,
              `Still running: ${PLUGIN_VERSION}. The new bundle activates on the next session start, not now.`,
              ...(changelog ? ['', "What's new:", changelog] : []),
              '',
              ...results,
            ].join('\n'),
          }],
        };
      } catch (err: any) {
        return { content: [{ type: 'text', text: `Update check failed: ${err.message}. ${restartPendingNote(installedVer)}` }] };
      }
    },
  );

}
