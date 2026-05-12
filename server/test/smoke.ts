import { configFromEnv, saveConfig, loadSavedConfig, getConfigPath } from '../src/config.js';
import { startAuthFlow, checkAuthStatus } from '../src/auth.js';
import { OAUTH_CLIENT_ID } from '../src/constants.js';
import { unlink } from 'fs/promises';

let passed = 0;
let failed = 0;

function assert(name: string, condition: boolean, detail = '') {
  if (condition) {
    console.log(`  OK  ${name}`);
    passed++;
  } else {
    console.log(`  FAIL  ${name}${detail ? ': ' + detail : ''}`);
    failed++;
  }
}

async function testConfig() {
  console.log('\n--- Config ---');

  const cfg = await configFromEnv();
  assert('clientId from constants', cfg.clientId === OAUTH_CLIENT_ID);
  assert('missing env vars → empty strings', cfg.developerToken === '' && cfg.refreshToken === '' && cfg.loginCustomerId === '');
}

async function testSaveLoadConfig() {
  console.log('\n--- Save/Load Config ---');

  const path = await saveConfig({ developerToken: 'test-token-123', loginCustomerId: '9876543210' });
  assert('saveConfig returns path', path.length > 0);

  const loaded = await loadSavedConfig();
  assert('developerToken saved', loaded.developerToken === 'test-token-123');
  assert('loginCustomerId saved', loaded.loginCustomerId === '9876543210');
  assert('savedAt present', typeof loaded.savedAt === 'string');

  const cfg = await configFromEnv();
  assert('configFromEnv reads saved developerToken', cfg.developerToken === 'test-token-123');
  assert('configFromEnv reads saved loginCustomerId', cfg.loginCustomerId === '9876543210');

  try { await unlink(path); } catch {}
}

async function testAuthFlow() {
  console.log('\n--- Auth Flow ---');

  const cfg = await configFromEnv();
  const { url, port } = startAuthFlow(cfg);

  assert('auth URL contains client_id', url.includes(OAUTH_CLIENT_ID));
  assert('auth URL contains adwords scope', url.includes('adwords'));
  assert('auth URL contains localhost redirect', url.includes(`localhost%3A${port}`));
  assert('port is 9876', port === 9876);

  const status = checkAuthStatus();
  assert('auth not completed yet', status.done === false);

  // test HTTP server responds
  try {
    const res = await fetch(`http://localhost:${port}/callback?error=test_only&state=fake`);
    assert('HTTP server responds', res.status === 200);
  } catch (e: any) {
    assert('HTTP server responds', false, e.message);
  }
}

async function main() {
  console.log('Smoke test: google-ads-baby MCP server\n');

  process.env['CLAUDE_PLUGIN_DATA'] = '/tmp/.gads-baby-test';

  await testConfig();
  await testSaveLoadConfig();
  await testAuthFlow();

  console.log(`\n--- Results: ${passed} passed, ${failed} failed ---`);
  process.exit(failed > 0 ? 1 : 0);
}

main();
