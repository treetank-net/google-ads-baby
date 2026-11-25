import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
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
    mkdirSync(dirname(localPath), { recursive: true });
    writeFileSync(staging, Buffer.from(await res.arrayBuffer()));
    renameSync(staging, localPath);
    return true;
  } catch {
    rmSync(staging, { force: true });
    return false;
  }
}

export const DEFAULT_UPDATE_FILES = [
  'server/bundle.cjs',
  'hooks.json',
  'scripts/safety-hook.js',
  'scripts/start-mcp.js',
  'CHANGELOG.md',
];

const REQUIRED_UPDATE_FILES = ['server/bundle.cjs'];
const VERSION_FILE = 'package.json';

export function isSafeUpdatePath(path: unknown): path is string {
  if (typeof path !== 'string' || !/^[A-Za-z0-9._/-]+$/.test(path)) return false;
  if (path.startsWith('/') || path.endsWith('/')) return false;
  return path.split('/').every((segment) => segment !== '' && segment !== '.' && segment !== '..');
}

export function resolveUpdateFiles(remotePackage: { updateFiles?: unknown }): { files: string[]; rejected: string[] } {
  const declared = Array.isArray(remotePackage.updateFiles) ? remotePackage.updateFiles : DEFAULT_UPDATE_FILES;
  const rejected = declared.filter((path) => !isSafeUpdatePath(path)).map((path) => String(path));
  const files = [...new Set([...REQUIRED_UPDATE_FILES, ...declared.filter(isSafeUpdatePath)])].filter((path) => path !== VERSION_FILE);
  return { files, rejected };
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
        const remote = await res.json() as { version?: string; updateFiles?: unknown };
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

        const { files, rejected } = resolveUpdateFiles(remote);
        for (const remotePath of files) {
          const ok = await downloadFile(remotePath, join(root, remotePath));
          results.push(`${remotePath}: ${ok ? 'OK' : 'FAILED'}`);
        }
        for (const path of rejected) results.push(`${path}: SKIPPED (unsafe path in updateFiles)`);
        const failed = results.filter((line) => line.endsWith('FAILED')).length;
        if (failed) {
          results.push(`${VERSION_FILE}: NOT UPDATED, ${failed} file(s) failed; the install stays at ${installedVer} so update_plugin can retry.`);
        } else {
          const ok = await downloadFile(VERSION_FILE, join(root, VERSION_FILE));
          results.push(`${VERSION_FILE}: ${ok ? 'OK' : 'FAILED'}`);
        }

        return {
          content: [{
            type: 'text',
            text: [
              ...(failed
                ? [`Update ${installedVer} → ${remoteVer} incomplete: ${failed} file(s) failed. Run update_plugin again.`]
                : [`Downloaded ${installedVer} → ${remoteVer}`, `Still running: ${PLUGIN_VERSION}. The new bundle activates on the next session start, not now.`]),
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
