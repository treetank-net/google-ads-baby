import http from 'http';
import { randomBytes } from 'crypto';
import { exec } from 'child_process';
import { saveConfig } from './config.js';
import type { AdsConfig } from './config.js';
import { GoogleAdsApi } from 'google-ads-api';

function openBrowser(url: string) {
  const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
  exec(`${cmd} "${url}"`);
}

const SCOPES = ['https://www.googleapis.com/auth/adwords'];

interface OAuthState {
  server: http.Server | null;
  port: number;
  stateParam: string;
  authUrl: string;
  resolved: boolean;
  cfg: AdsConfig;
}

let oauthState: OAuthState | null = null;

async function exchangeCodeForTokens(
  code: string, clientId: string, clientSecret: string, redirectUri: string,
): Promise<string> {
  const body = new URLSearchParams({
    code, client_id: clientId, client_secret: clientSecret,
    redirect_uri: redirectUri, grant_type: 'authorization_code',
  });
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  if (!res.ok) throw new Error(`Token exchange failed: ${await res.text()}`);
  const data = await res.json() as { refresh_token?: string };
  if (!data.refresh_token) {
    throw new Error('No refresh_token. Revoke access at https://myaccount.google.com/permissions and try again.');
  }
  return data.refresh_token;
}

async function listAccessibleAccounts(cfg: AdsConfig): Promise<Array<{ id: string; name: string; manager?: boolean }>> {
  const api = new GoogleAdsApi({
    client_id: cfg.clientId, client_secret: cfg.clientSecret, developer_token: cfg.developerToken,
  });
  const response = await api.listAccessibleCustomers(cfg.refreshToken);
  const resourceNames = response.resource_names ?? [];
  const accounts = await Promise.all(resourceNames.map(async (resourceName: string) => {
    const id = resourceName.replace('customers/', '');
    try {
      const customer = api.Customer({ customer_id: id, refresh_token: cfg.refreshToken });
      const rows = await customer.query(`
        SELECT customer.id, customer.descriptive_name, customer.manager
        FROM customer
        LIMIT 1
      `);
      const row = rows[0] as any;
      return {
        id,
        name: row?.customer?.descriptive_name || id,
        manager: row?.customer?.manager,
      };
    } catch {
      return { id, name: id };
    }
  }));
  const visibleAccounts = accounts.some((account) => account.manager)
    ? accounts.filter((account) => account.manager)
    : accounts;

  return visibleAccounts.sort((a, b) => {
    if (a.manager !== b.manager) return a.manager ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c: Buffer) => data += c.toString());
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

const SETUP_PAGE = `<!DOCTYPE html><html><head><meta charset="utf-8">
<style>
  * { box-sizing: border-box; }
  body { font-family: system-ui; display:flex; justify-content:center; align-items:center;
         min-height:100vh; margin:0; background:#f0f4f8; }
  .card { background:white; padding:2.5rem; border-radius:12px; box-shadow:0 2px 8px rgba(0,0,0,.1);
          max-width:480px; width:100%; }
  h1 { color:#16a34a; margin:0 0 .5rem; font-size:1.5rem; }
  .step { margin:1.5rem 0; }
  label { display:block; font-weight:600; margin-bottom:.25rem; }
  .hint { font-size:.85rem; color:#666; margin-bottom:.5rem; }
  input, select { width:100%; padding:.6rem; border:1px solid #ddd; border-radius:6px; font-size:1rem; }
  button { background:#2563eb; color:white; border:none; padding:.7rem 1.5rem; border-radius:6px;
           font-size:1rem; cursor:pointer; margin-top:.5rem; }
  button:hover { background:#1d4ed8; }
  button:disabled { background:#94a3b8; cursor:wait; }
  .error { color:#dc2626; font-size:.9rem; margin-top:.5rem; }
  .done { text-align:center; }
  .done h1 { font-size:2rem; }
  #accounts-step { display:none; }
  #done-step { display:none; }
</style></head><body><div class="card">
  <div id="token-step">
    <h1>Google Ads Setup</h1>
    <p>Authorization complete. Now enter your developer token.</p>
    <div class="step">
      <label>Developer Token</label>
      <div class="hint">You can find it in <a href="https://ads.google.com/aw/apicenter" target="_blank">Google Ads → API Center</a></div>
      <input id="dev-token" placeholder="e.g. aBcDeFgHiJkLmN0P">
    </div>
    <button id="btn-load">Load account list</button>
    <div id="token-error" class="error"></div>
  </div>
  <div id="accounts-step">
    <h1>Select account</h1>
    <div class="step">
      <label>MCC Account ID</label>
      <select id="account-select"></select>
    </div>
    <div class="step">
      <label>Safety level</label>
      <select id="safety-level">
        <option value="standard" selected>standard - safe word, 1h TTL</option>
        <option value="strict">strict - safe word, 5 min TTL</option>
        <option value="off">off - no Claude hook gate</option>
      </select>
    </div>
    <div class="step">
      <label>Mutation token TTL (seconds)</label>
      <div class="hint">Optional. Leave empty to use the default for the selected level.</div>
      <input id="mutation-ttl" type="number" min="1" step="1" placeholder="e.g. 3600">
    </div>
    <div class="step">
      <label>Confirmation state TTL (seconds)</label>
      <div class="hint">Optional for the Claude Code hook. Leave empty to use the default for the selected level.</div>
      <input id="confirm-ttl" type="number" min="1" step="1" placeholder="e.g. 3600">
    </div>
    <button id="btn-save">Save and finish</button>
    <div id="accounts-error" class="error"></div>
  </div>
  <div id="done-step" class="done">
    <h1>Done!</h1>
    <p>Configuration saved.<br>Close this tab and return to the chat.</p>
  </div>
</div>
<script>
const btnLoad = document.getElementById('btn-load');
const btnSave = document.getElementById('btn-save');

btnLoad.onclick = async () => {
  const devToken = document.getElementById('dev-token').value.trim();
  const errEl = document.getElementById('token-error');
  errEl.textContent = '';
  if (!devToken) { errEl.textContent = 'Developer token is required.'; return; }
  btnLoad.disabled = true; btnLoad.textContent = 'Loading...';
  try {
    const res = await fetch('/list-accounts', {
      method: 'POST', headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ developer_token: devToken })
    });
    const data = await res.json();
    if (data.error) { errEl.textContent = data.error; btnLoad.disabled = false; btnLoad.textContent = 'Load account list'; return; }
    if (!data.accounts || data.accounts.length === 0) { errEl.textContent = 'No accessible Google Ads accounts found for this user.'; btnLoad.disabled = false; btnLoad.textContent = 'Load account list'; return; }
    const sel = document.getElementById('account-select');
    sel.innerHTML = '';
    data.accounts.forEach(a => {
      const opt = document.createElement('option');
      opt.value = a.id;
      opt.textContent = a.name + ' (' + a.id + ')' + (a.manager ? ' [MCC]' : '');
      sel.appendChild(opt);
    });
    document.getElementById('token-step').style.display = 'none';
    document.getElementById('accounts-step').style.display = 'block';
  } catch (e) { errEl.textContent = 'Connection error: ' + e.message; btnLoad.disabled = false; btnLoad.textContent = 'Load account list'; }
};

btnSave.onclick = async () => {
  const devToken = document.getElementById('dev-token').value.trim();
  const mccId = document.getElementById('account-select').value;
  const safetyLevel = document.getElementById('safety-level').value;
  const mutationTtl = document.getElementById('mutation-ttl').value.trim();
  const confirmTtl = document.getElementById('confirm-ttl').value.trim();
  const errEl = document.getElementById('accounts-error');
  errEl.textContent = '';
  if (!mccId) { errEl.textContent = 'Select an account from the list.'; return; }
  if (!['strict', 'standard', 'off'].includes(safetyLevel)) { errEl.textContent = 'Invalid safety level.'; return; }
  if (mutationTtl && !/^\\d+$/.test(mutationTtl)) { errEl.textContent = 'Mutation token TTL must be a number of seconds.'; return; }
  if (confirmTtl && !/^\\d+$/.test(confirmTtl)) { errEl.textContent = 'Confirmation state TTL must be a number of seconds.'; return; }
  btnSave.disabled = true;
  try {
    const res = await fetch('/save-config', {
      method: 'POST', headers: {'Content-Type':'application/json'},
      body: JSON.stringify({
        developer_token: devToken,
        mcc_id: mccId,
        safety_level: safetyLevel,
        mutation_token_ttl_seconds: mutationTtl,
        confirm_state_ttl_seconds: confirmTtl
      })
    });
    const data = await res.json();
    if (data.error) { errEl.textContent = data.error; btnSave.disabled = false; return; }
    document.getElementById('accounts-step').style.display = 'none';
    document.getElementById('done-step').style.display = 'block';
  } catch (e) { errEl.textContent = 'Error: ' + e.message; btnSave.disabled = false; }
};
</script></body></html>`;

function buildAuthUrl(clientId: string, stateParam: string, port: number): string {
  const authUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  authUrl.searchParams.set('client_id', clientId);
  authUrl.searchParams.set('redirect_uri', `http://localhost:${port}/callback`);
  authUrl.searchParams.set('response_type', 'code');
  authUrl.searchParams.set('scope', SCOPES.join(' '));
  authUrl.searchParams.set('access_type', 'offline');
  authUrl.searchParams.set('prompt', 'consent');
  authUrl.searchParams.set('state', stateParam);
  return authUrl.toString();
}

const OPEN_PAGE = `<!DOCTYPE html><html><head><meta charset="utf-8">
<style>
  * { box-sizing: border-box; }
  body { font-family: system-ui; display:flex; justify-content:center; align-items:center;
         min-height:100vh; margin:0; background:#f0f4f8; }
  .card { background:white; padding:2.5rem; border-radius:12px; box-shadow:0 2px 8px rgba(0,0,0,.1);
          max-width:520px; width:100%; }
  h1 { color:#16a34a; margin:0 0 .5rem; font-size:1.5rem; }
  p { color:#444; line-height:1.5; }
  .custom-fields { display:none; margin:1rem 0; }
  .custom-fields.show { display:block; }
  label { display:block; font-weight:600; margin-bottom:.25rem; margin-top:.75rem; }
  .hint { font-size:.85rem; color:#666; margin-bottom:.5rem; }
  input { width:100%; padding:.6rem; border:1px solid #ddd; border-radius:6px; font-size:1rem; }
  .buttons { margin-top:1.5rem; display:flex; gap:.75rem; flex-wrap:wrap; }
  button { border:none; padding:.7rem 1.5rem; border-radius:6px; font-size:1rem; cursor:pointer; }
  .btn-primary { background:#2563eb; color:white; }
  .btn-primary:hover { background:#1d4ed8; }
  .btn-secondary { background:#e2e8f0; color:#334155; }
  .btn-secondary:hover { background:#cbd5e1; }
  button:disabled { opacity:.5; cursor:wait; }
  .error { color:#dc2626; font-size:.9rem; margin-top:.5rem; }
  .toggle { color:#2563eb; cursor:pointer; font-size:.9rem; margin-top:.75rem; display:inline-block; }
  .toggle:hover { text-decoration:underline; }
</style></head><body><div class="card">
  <h1>Google Ads — Authorize</h1>
  <p>Click below to sign in with Google and grant access to your Google Ads accounts.</p>
  <span class="toggle" id="toggle-custom">I want to use my own OAuth app credentials</span>
  <div class="custom-fields" id="custom-fields">
    <label>Client ID</label>
    <div class="hint">From <a href="https://console.cloud.google.com/apis/credentials" target="_blank">Google Cloud Console → Credentials</a></div>
    <input id="custom-id" placeholder="123456789-abc.apps.googleusercontent.com">
    <label>Client Secret</label>
    <input id="custom-secret" placeholder="GOCSPX-..." type="password">
  </div>
  <div class="buttons">
    <button class="btn-primary" id="btn-go">Sign in with Google</button>
  </div>
  <div id="open-error" class="error"></div>
</div>
<script>
const toggle = document.getElementById('toggle-custom');
const fields = document.getElementById('custom-fields');
let showCustom = false;
toggle.onclick = () => {
  showCustom = !showCustom;
  fields.classList.toggle('show', showCustom);
  toggle.textContent = showCustom
    ? 'Use default app credentials'
    : 'I want to use my own OAuth app credentials';
};

document.getElementById('btn-go').onclick = async () => {
  const btn = document.getElementById('btn-go');
  const errEl = document.getElementById('open-error');
  errEl.textContent = '';
  const clientId = document.getElementById('custom-id').value.trim();
  const clientSecret = document.getElementById('custom-secret').value.trim();
  if (showCustom && (!clientId || !clientSecret)) {
    errEl.textContent = 'Both Client ID and Client Secret are required, or collapse the section to use the default app.';
    return;
  }
  btn.disabled = true;
  try {
    const res = await fetch('/start-oauth', {
      method: 'POST', headers: {'Content-Type':'application/json'},
      body: JSON.stringify(showCustom ? { client_id: clientId, client_secret: clientSecret } : {})
    });
    const data = await res.json();
    if (data.error) { errEl.textContent = data.error; btn.disabled = false; return; }
    window.location.href = data.url;
  } catch (e) { errEl.textContent = 'Connection error: ' + e.message; btn.disabled = false; }
};
</script></body></html>`;

export function startAuthFlow(cfg: AdsConfig): { url: string; shortUrl: string; port: number } {
  if (oauthState?.server) oauthState.server.close();

  const stateParam = randomBytes(16).toString('hex');
  const port = 9876;
  const redirectUri = `http://localhost:${port}/callback`;

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || '/', `http://localhost:${port}`);
    const json = (status: number, data: object) => {
      res.writeHead(status, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify(data));
    };
    const html = (status: number, body: string) => {
      res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(body);
    };

    if (url.pathname === '/callback') {
      const code = url.searchParams.get('code');
      const state = url.searchParams.get('state');
      const error = url.searchParams.get('error');
      if (error) { html(200, `<h1>Authorization error</h1><p>${error}</p>`); return; }
      if (state !== stateParam || !code) { html(400, '<h1>Invalid request</h1>'); return; }
      try {
        const refreshToken = await exchangeCodeForTokens(code, cfg.clientId, cfg.clientSecret, redirectUri);
        await saveConfig({ refreshToken });
        cfg.refreshToken = refreshToken;
        html(200, SETUP_PAGE);
      } catch (err: any) {
        html(500, `<h1>Error</h1><p>${err.message}</p>`);
      }
      return;
    }

    if (url.pathname === '/open') {
      if (!oauthState) { html(404, '<h1>Authorization flow not active</h1>'); return; }
      html(200, OPEN_PAGE);
      return;
    }

    if (url.pathname === '/start-oauth' && req.method === 'POST') {
      if (!oauthState) { json(404, { error: 'Authorization flow not active' }); return; }
      try {
        const body = JSON.parse(await readBody(req));
        const customId = (body.client_id || '').trim();
        const customSecret = (body.client_secret || '').trim();
        if (customId && customSecret) {
          cfg.clientId = customId;
          cfg.clientSecret = customSecret;
          await saveConfig({ clientId: customId, clientSecret: customSecret });
        }
        const authUrl = buildAuthUrl(cfg.clientId, oauthState.stateParam, oauthState.port);
        oauthState.authUrl = authUrl;
        json(200, { url: authUrl });
      } catch (err: any) {
        json(500, { error: err.message || String(err) });
      }
      return;
    }

    if (url.pathname === '/list-accounts' && req.method === 'POST') {
      try {
        const body = JSON.parse(await readBody(req));
        cfg.developerToken = body.developer_token;
        const accounts = await listAccessibleAccounts(cfg);
        json(200, { accounts });
      } catch (err: any) {
        const msg = typeof err.message === 'string' ? err.message : JSON.stringify(err.message ?? err);
        json(500, { error: msg });
      }
      return;
    }

    if (url.pathname === '/save-config' && req.method === 'POST') {
      try {
        const body = JSON.parse(await readBody(req));
        const safetyLevel = ['strict', 'standard', 'off'].includes(body.safety_level) ? body.safety_level : 'standard';
        const mutationTokenTtlSeconds = /^\\d+$/.test(String(body.mutation_token_ttl_seconds || '')) ? String(body.mutation_token_ttl_seconds) : '';
        const confirmStateTtlSeconds = /^\\d+$/.test(String(body.confirm_state_ttl_seconds || '')) ? String(body.confirm_state_ttl_seconds) : '';
        await saveConfig({
          developerToken: body.developer_token,
          loginCustomerId: body.mcc_id,
          safetyLevel,
          mutationTokenTtlSeconds,
          confirmStateTtlSeconds,
        });
        cfg.developerToken = body.developer_token;
        cfg.loginCustomerId = body.mcc_id;
        cfg.safetyLevel = safetyLevel;
        cfg.mutationTokenTtlSeconds = mutationTokenTtlSeconds;
        cfg.confirmStateTtlSeconds = confirmStateTtlSeconds;
        process.env['GOOGLE_ADS_SAFETY_LEVEL'] = safetyLevel;
        if (mutationTokenTtlSeconds) process.env['GOOGLE_ADS_MUTATION_TOKEN_TTL_SECONDS'] = mutationTokenTtlSeconds;
        else delete process.env['GOOGLE_ADS_MUTATION_TOKEN_TTL_SECONDS'];
        if (confirmStateTtlSeconds) process.env['GOOGLE_ADS_CONFIRM_STATE_TTL_SECONDS'] = confirmStateTtlSeconds;
        else delete process.env['GOOGLE_ADS_CONFIRM_STATE_TTL_SECONDS'];
        oauthState!.resolved = true;
        json(200, { ok: true });
        cleanup();
      } catch (err: any) {
        json(500, { error: err.message || String(err) });
      }
      return;
    }

    res.writeHead(404); res.end('Not found');
  });

  server.listen(port, '127.0.0.1');

  const url = buildAuthUrl(cfg.clientId, stateParam, port);
  oauthState = { server, port, stateParam, authUrl: url, resolved: false, cfg };

  openBrowser(`http://127.0.0.1:${port}/open`);

  return { url, shortUrl: `http://127.0.0.1:${port}/open`, port };
}

export function checkAuthStatus(): { done: boolean } {
  return { done: oauthState?.resolved ?? false };
}

function cleanup() {
  if (oauthState?.server) {
    setTimeout(() => { oauthState?.server?.close(); oauthState!.server = null; }, 2000);
  }
}
