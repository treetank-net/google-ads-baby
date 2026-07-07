import { configFromEnv, saveConfig, loadSavedConfig, getConfigPath } from '../src/config.js';
import { startAuthFlow, checkAuthStatus } from '../src/auth.js';
import { OAUTH_CLIENT_ID } from '../src/constants.js';
import { unlink } from 'fs/promises';
import {
  analyzeAccountHygiene,
  analyzeScalingCandidates,
  analyzeSearchTermsWaste,
  analyzePmaxBreakdown,
  windowClause,
  MICROS,
} from '../src/tools/analysis-helpers.js';

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

function m(units: number): number {
  return units * MICROS;
}

function testAnalysis() {
  console.log('\n--- Analysis (P1 read tools) ---');

  // Account hygiene: one healthy, one zero-spend, one low-util, one spend-no-conv.
  const hygiene = analyzeAccountHygiene(
    [
      { campaign: { id: 1, name: 'Healthy' }, campaign_budget: { amount_micros: m(100) }, metrics: { cost_micros: m(2100), conversions: 30 } }, // util 0.7
      { campaign: { id: 2, name: 'ZeroSpend' }, campaign_budget: { amount_micros: m(50) }, metrics: { cost_micros: m(0), conversions: 0 } },
      { campaign: { id: 3, name: 'LowUtil' }, campaign_budget: { amount_micros: m(100) }, metrics: { cost_micros: m(150), conversions: 4 } }, // util 0.05
      { campaign: { id: 4, name: 'NoConv' }, campaign_budget: { amount_micros: m(100) }, metrics: { cost_micros: m(300), conversions: 0 } }, // util 0.1 + no conv
    ],
    30,
  );
  const codes = hygiene.map((f) => f.code);
  assert('hygiene: healthy campaign produces no finding', !hygiene.some((f) => f.entity.includes('Healthy')));
  assert('hygiene: zero_spend flagged', codes.includes('zero_spend'));
  assert('hygiene: low_utilization flagged', codes.includes('low_utilization'));
  assert('hygiene: spend_no_conversions flagged', codes.includes('spend_no_conversions'));
  assert('hygiene: zero_spend is critical', hygiene.find((f) => f.code === 'zero_spend')?.severity === 'critical');
  assert('hygiene: budget_change suggested on low_util', (hygiene.find((f) => f.code === 'low_utilization')?.prepare_actions ?? []).includes('prepare_budget_change'));

  // Scaling: budget-constrained candidate vs not.
  const scaling = analyzeScalingCandidates(
    [
      { campaign: { id: 10, name: 'Constrained' }, campaign_budget: { amount_micros: m(100) }, metrics: { cost_micros: m(2850), conversions: 40, conversions_value: 8000, search_budget_lost_impression_share: 0.25 } }, // util 0.95, lostIS 0.25
      { campaign: { id: 11, name: 'Fine' }, campaign_budget: { amount_micros: m(100) }, metrics: { cost_micros: m(1500), conversions: 20, search_budget_lost_impression_share: 0.02 } }, // util 0.5
      { campaign: { id: 12, name: 'HighUtilNoLostIS' }, campaign_budget: { amount_micros: m(100) }, metrics: { cost_micros: m(2850), conversions: 5, search_budget_lost_impression_share: 0.05 } }, // util high but lostIS low
    ],
    30,
  );
  assert('scaling: only the constrained campaign is a candidate', scaling.length === 1 && scaling[0].entity.includes('Constrained'));
  assert('scaling: ROAS computed', scaling[0]?.metrics.roas === 2.81 || (scaling[0]?.metrics.roas as number) > 0);
  assert('scaling: points at budget-scaling workflow', scaling[0]?.suggested_task.suggested_workflow === 'google-ads/budget-scaling-seasonality.md');

  // Search-terms waste: waste term, bounce-back excluded, aggregation across rows, sub-threshold ignored.
  const rows30 = [
    { search_term_view: { search_term: 'waste term' }, campaign: { id: 1, name: 'C' }, metrics: { cost_micros: m(30), conversions: 0 } },
    { search_term_view: { search_term: 'waste term' }, campaign: { id: 1, name: 'C' }, metrics: { cost_micros: m(40), conversions: 0 } }, // aggregates to 70
    { search_term_view: { search_term: 'bounce back' }, campaign: { id: 1, name: 'C' }, metrics: { cost_micros: m(80), conversions: 0 } },
    { search_term_view: { search_term: 'cheap term' }, campaign: { id: 1, name: 'C' }, metrics: { cost_micros: m(10), conversions: 0 } }, // below threshold
    { search_term_view: { search_term: 'converts now' }, campaign: { id: 1, name: 'C' }, metrics: { cost_micros: m(90), conversions: 3 } }, // has conv
  ];
  const rows90 = [
    { search_term_view: { search_term: 'bounce back' }, campaign: { id: 1, name: 'C' }, metrics: { cost_micros: m(200), conversions: 5 } }, // converted historically
  ];
  const waste = analyzeSearchTermsWaste(rows30, rows90);
  const wasteTerms = waste.findings.map((f) => f.entity);
  assert('waste: "waste term" flagged (aggregated 70)', wasteTerms.some((e) => e.includes('waste term')));
  assert('waste: bounce-back excluded, not flagged', !wasteTerms.some((e) => e.includes('bounce back')));
  assert('waste: bounce-back recorded in excluded list', waste.excluded_bounce_back.includes('bounce back'));
  assert('waste: sub-threshold term ignored', !wasteTerms.some((e) => e.includes('cheap term')));
  assert('waste: converting term ignored', !wasteTerms.some((e) => e.includes('converts now')));
  assert('waste: negative-keyword action suggested', (waste.findings[0]?.prepare_actions ?? []).includes('prepare_negative_keywords'));

  // PMax: asset-group breakdown + zero-conversion flag + share math.
  const pmax = analyzePmaxBreakdown([
    { campaign: { id: 1, name: 'PMax A' }, asset_group: { id: 1, name: 'Good AG' }, metrics: { cost_micros: m(100), conversions: 10 } },
    { campaign: { id: 1, name: 'PMax A' }, asset_group: { id: 2, name: 'Dead AG' }, metrics: { cost_micros: m(100), conversions: 0 } },
  ]);
  assert('pmax: breakdown has both asset groups', pmax.breakdown.length === 2);
  assert('pmax: share is 0.5 each', pmax.breakdown.every((b) => b.share === 0.5));
  assert('pmax: dead asset group flagged', pmax.findings.some((f) => f.entity.includes('Dead AG')));
  assert('pmax: healthy asset group not flagged', !pmax.findings.some((f) => f.entity.includes('Good AG')));

  // windowClause: valid GAQL BETWEEN, ends yesterday, spans requested days.
  const clause = windowClause(90);
  assert('windowClause: is a BETWEEN clause', /^segments\.date BETWEEN '\d{4}-\d{2}-\d{2}' AND '\d{4}-\d{2}-\d{2}'$/.test(clause));
  const dates = clause.match(/'(\d{4}-\d{2}-\d{2})'/g)!.map((s) => s.replace(/'/g, ''));
  const spanDays = (Date.parse(dates[1]) - Date.parse(dates[0])) / 86400000;
  assert('windowClause: spans 89 days between endpoints (90 inclusive)', spanDays === 89);
}

async function main() {
  console.log('Smoke test: google-ads-baby MCP server\n');

  process.env['CLAUDE_PLUGIN_DATA'] = '/tmp/.gads-baby-test';

  await testConfig();
  await testSaveLoadConfig();
  await testAuthFlow();
  testAnalysis();

  console.log(`\n--- Results: ${passed} passed, ${failed} failed ---`);
  process.exit(failed > 0 ? 1 : 0);
}

main();
