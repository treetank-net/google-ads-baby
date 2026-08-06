import { configFromEnv, saveConfig, loadSavedConfig, getConfigPath } from '../src/config.js';
import { startAuthFlow, checkAuthStatus } from '../src/auth.js';
import { OAUTH_CLIENT_ID } from '../src/constants.js';
import { unlink } from 'fs/promises';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerWriteTools } from '../src/tools/write.js';
import { updatedFieldNames } from '../src/history.js';
import {
  MAX_BUDGET_MICROS,
  MAX_CPC_MICROS,
  MAX_TARGET_CPA_MICROS,
} from '../src/tools/write-schemas.js';
import {
  PLN_FIELD_LIMITS,
  plnFieldLimitError,
  budgetLimitError,
  cpcLimitError,
  targetCpaLimitError,
  changeLine,
  microsChangeLine,
  manualBiddingRequiredWarning,
  sharedBudgetWarning,
  validateResponsiveDisplayText,
} from '../src/tools/write-helpers.js';
import {
  analyzeAccountHygiene,
  analyzeScalingCandidates,
  analyzeSearchTermsWaste,
  analyzePmaxBreakdown,
  analyzeDisplayRemarketing,
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

// Fields that carry an amount for preview only and never reach a mutation,
// so a safety cap on them would be meaningless.
const CAP_SWEEP_EXEMPT = new Set(['prepare_budget_change.current_budget_pln']);

function registeredWriteTools(): Record<string, any> {
  const server = new McpServer({ name: 'smoke', version: '0.0.0' });
  registerWriteTools(server, {
    clientId: '',
    clientSecret: '',
    developerToken: '',
    refreshToken: '',
    loginCustomerId: '',
    safetyLevel: 'standard',
  } as any);
  return (server as any)._registeredTools as Record<string, any>;
}

function toolFieldNames(tool: any): string[] {
  return Object.keys(tool?.inputSchema?.shape ?? {});
}

function resultText(result: any): string {
  return String(result?.content?.[0]?.text ?? '');
}

function testLimitHelpers() {
  console.log('\n--- Mutation limit helpers ---');

  assert('budget at the cap is allowed', budgetLimitError(MAX_BUDGET_MICROS / 1_000_000) === null);
  assert('budget above the cap is rejected', (budgetLimitError(MAX_BUDGET_MICROS / 1_000_000 + 1) ?? '').includes('safety limit'));
  assert('CPC at the cap is allowed', cpcLimitError(MAX_CPC_MICROS / 1_000_000) === null);
  assert('CPC above the cap is rejected', (cpcLimitError(MAX_CPC_MICROS / 1_000_000 + 0.01) ?? '').includes('safety limit'));
  assert('target CPA at the cap is allowed', targetCpaLimitError(MAX_TARGET_CPA_MICROS / 1_000_000) === null);
  assert('target CPA above the cap is rejected', (targetCpaLimitError(MAX_TARGET_CPA_MICROS / 1_000_000 + 1) ?? '').includes('safety limit'));

  // Nested payloads (the *_full tools) must be walked, not just top-level fields.
  const nested = { customer_id: '1', daily_budget_pln: 100, ad_groups: [{ name: 'a', cpc_bid_pln: 2 }, { name: 'b', cpc_bid_pln: 9999 }] };
  const nestedError = plnFieldLimitError(nested) ?? '';
  assert('nested cpc_bid_pln over the cap is caught', nestedError.includes('safety limit'));
  assert('nested error names the offending path', nestedError.includes('ad_groups[1].cpc_bid_pln'));
  assert('clean nested payload passes', plnFieldLimitError({ daily_budget_pln: 10, ad_groups: [{ cpc_bid_pln: 3 }] }) === null);
  assert('deeply nested bidding target is caught', (plnFieldLimitError({ bidding: { target_cpa_pln: 100000 } }) ?? '').includes('Target CPA'));

  assert('before -> after keeps both values', changeLine('Status', 'PAUSED', 'ENABLED') === 'Status: PAUSED → ENABLED');
  assert('missing previous value is explicit', changeLine('Name', undefined, 'x').includes('(not set)'));
  assert('12x bid increase is called out', microsChangeLine('Max CPC', 200_000, 2_500_000).includes('12.5x more'));
  assert('halving is called out as less', microsChangeLine('Max CPC', 2_000_000, 500_000).includes('4.0x less'));
  assert('small change shows percent', microsChangeLine('Daily budget', 100_000_000, 110_000_000).includes('+10%'));
  assert('unknown previous amount degrades gracefully', microsChangeLine('Max CPC', undefined, 1_000_000).includes('(not set)'));

  assert('manual CPC needs no bidding warning', manualBiddingRequiredWarning('MANUAL_CPC') === null);
  assert('automated bidding warns that CPC is ignored', (manualBiddingRequiredWarning('MAXIMIZE_CONVERSIONS') ?? '').includes('will not affect delivery'));
  assert('unshared budget needs no warning', sharedBudgetWarning(1, false) === null);
  assert('shared budget warns about other campaigns', (sharedBudgetWarning(3, true) ?? '').includes('3 campaign(s)'));

  assert('display ad text limits enforced', (validateResponsiveDisplayText(['a', 'b', 'c', 'd', 'e', 'f'], ['d']) ?? '').includes('1-5 headlines'));
  assert('valid display ad text passes', validateResponsiveDisplayText(['a'], ['d']) === null);

  assert('identifier keys are not reported as changed fields', !updatedFieldNames({ customer_id: '1', ad_group_id: '2', status: 'PAUSED' }).includes('ad_group_id'));
  assert('changed fields are reported', updatedFieldNames({ customer_id: '1', cpc_bid_micros: 5, status: 'PAUSED' }).sort().join(',') === 'cpc_bid_micros,status');
}

function testToolContract() {
  console.log('\n--- Tool contract ---');

  const tools = registeredWriteTools();
  assert('prepare_ad_group_update is registered', 'prepare_ad_group_update' in tools);
  assert('prepare_campaign_update is registered', 'prepare_campaign_update' in tools);
  assert('prepare_ad_update is registered', 'prepare_ad_update' in tools);
  assert('prepare_ad_group_settings is gone', !('prepare_ad_group_settings' in tools));

  // Every field a create tool sets must have an update path, or the plugin can
  // create state it cannot fix (the gap this release closes).
  const adGroupUpdateFields = toolFieldNames(tools['prepare_ad_group_update']);
  for (const [createField, updateField] of [['cpc_bid_pln', 'cpc_bid_pln'], ['ad_group_name', 'name'], ['optimized_targeting_enabled', 'optimized_targeting_enabled']]) {
    assert(`ad group create field ${createField} has an update path`, adGroupUpdateFields.includes(updateField));
  }
  const campaignUpdateFields = toolFieldNames(tools['prepare_campaign_update']);
  for (const [createField, updateField] of [['campaign_name', 'name'], ['daily_budget_pln', 'daily_budget_pln'], ['status', 'status']]) {
    assert(`campaign create field ${createField} has an update path`, campaignUpdateFields.includes(updateField));
  }

  // Any *_pln field must match a known limit rule; a field that only hits the
  // fallback is a cap waiting to be forgotten.
  const unmatched: string[] = [];
  for (const [toolName, tool] of Object.entries(tools)) {
    for (const field of toolFieldNames(tool)) {
      if (!field.endsWith('_pln')) continue;
      if (!PLN_FIELD_LIMITS.some((rule) => rule.match.test(field))) unmatched.push(`${toolName}.${field}`);
    }
  }
  assert('every *_pln field maps to a limit rule', unmatched.length === 0, unmatched.join(', '));
}

async function testCapEnforcement() {
  console.log('\n--- Cap enforcement (every money field, every tool) ---');

  const tools = registeredWriteTools();
  const skipped: string[] = [];
  let checked = 0;

  for (const [toolName, tool] of Object.entries(tools)) {
    for (const field of toolFieldNames(tool)) {
      if (!field.endsWith('_pln')) continue;
      const key = `${toolName}.${field}`;
      if (CAP_SWEEP_EXEMPT.has(key)) {
        skipped.push(key);
        continue;
      }
      const args: Record<string, unknown> = { customer_id: '1234567890', safe_word: 'smoke', [field]: 10_000_000 };
      if (toolFieldNames(tool).includes('campaign_id')) args['campaign_id'] = '1';
      if (toolFieldNames(tool).includes('ad_group_id')) args['ad_group_id'] = '1';
      if (toolFieldNames(tool).includes('budget_id')) args['budget_id'] = '1';
      if (field === 'target_cpa_pln') args['strategy_type'] = 'TARGET_CPA';
      let text = '';
      try {
        text = resultText(await tool.handler(args, {}));
      } catch (err: any) {
        text = `threw: ${err?.message ?? err}`;
      }
      checked += 1;
      assert(`${key} rejects an absurd amount`, text.startsWith('Error:') && text.includes('safety limit'), text.slice(0, 160));
    }
  }

  console.log(`  checked ${checked} money field(s); exempt: ${skipped.length ? skipped.join(', ') : 'none'}`);
}

function testDisplayRemarketing() {
  console.log('\n--- Display remarketing diagnostics ---');

  const list = (id: number, size: number | undefined, eligible: boolean, life = 30) => ({
    user_list: { id, name: `list ${id}`, resource_name: `customers/1/userLists/${id}`, size_for_display: size, eligible_for_display: eligible, membership_life_span: life },
  });

  // Manual CPC campaign, tiny list, floor-level bid: the bid is a valid test here,
  // but the undersized list is the blocking problem.
  const manual = analyzeDisplayRemarketing({
    campaigns: [{ campaign: { id: 1, name: 'RMKT SK', status: 'ENABLED', serving_status: 'SERVING', bidding_strategy_type: 'MANUAL_CPC' }, campaign_budget: { amount_micros: m(20) }, metrics: { impressions: 0 } }],
    adGroups: [{ campaign: { id: 1 }, ad_group: { id: 11, name: 'AG', status: 'ENABLED', cpc_bid_micros: 50_000 } }],
    audiences: [{ campaign: { id: 1 }, ad_group: { id: 11 }, ad_group_criterion: { status: 'ENABLED', user_list: { user_list: 'customers/1/userLists/9' } } }],
    userLists: [list(9, 40, true)],
  }, 30);
  const manualCodes = manual.findings.map((f) => f.code);
  assert('display: undersized list flagged critical', manual.findings.some((f) => f.code === 'audience_below_display_minimum' && f.severity === 'critical'));
  assert('display: zero impressions flagged', manualCodes.includes('zero_impressions'));
  assert('display: floor-level manual CPC flagged', manualCodes.includes('manual_cpc_below_floor'));
  assert('display: bid finding points at prepare_ad_group_update', manual.findings.find((f) => f.code === 'manual_cpc_below_floor')?.prepare_actions.includes('prepare_ad_group_update') === true);
  assert('display: no bogus bids-not-the-constraint note on manual CPC', !manualCodes.includes('bids_not_the_constraint'));
  assert('display: audience coverage reported', manual.audience_coverage.length === 1);

  // Automated bidding: raising CPC cannot fix delivery, and the report must say so.
  const automated = analyzeDisplayRemarketing({
    campaigns: [{ campaign: { id: 2, name: 'RMKT HU', status: 'ENABLED', serving_status: 'SERVING', bidding_strategy_type: 'MAXIMIZE_CONVERSIONS' }, campaign_budget: { amount_micros: m(20) }, metrics: { impressions: 0 } }],
    adGroups: [{ campaign: { id: 2 }, ad_group: { id: 21, name: 'AG', status: 'ENABLED', cpc_bid_micros: 50_000 } }],
    audiences: [{ campaign: { id: 2 }, ad_group: { id: 21 }, ad_group_criterion: { status: 'ENABLED', user_list: { user_list: 'customers/1/userLists/8' } } }],
    userLists: [list(8, 5000, true)],
  }, 30);
  const automatedCodes = automated.findings.map((f) => f.code);
  assert('display: automated bidding gets an explicit bids-are-ignored note', automatedCodes.includes('bids_not_the_constraint'));
  assert('display: low bid not flagged under automated bidding', !automatedCodes.includes('manual_cpc_below_floor'));
  assert('display: healthy list not flagged', !automatedCodes.includes('audience_below_display_minimum'));

  // Structural blockers: no audience at all, and a non-serving campaign.
  const structural = analyzeDisplayRemarketing({
    campaigns: [
      { campaign: { id: 3, name: 'No audience', status: 'ENABLED', serving_status: 'SERVING', bidding_strategy_type: 'MANUAL_CPC' }, campaign_budget: { amount_micros: m(30) }, metrics: { impressions: 0 } },
      { campaign: { id: 4, name: 'Suspended', status: 'ENABLED', serving_status: 'SUSPENDED', bidding_strategy_type: 'MANUAL_CPC' }, campaign_budget: { amount_micros: m(30) }, metrics: { impressions: 0 } },
    ],
    adGroups: [{ campaign: { id: 4 }, ad_group: { id: 41, name: 'AG', status: 'PAUSED', cpc_bid_micros: m(1) } }],
    audiences: [{ campaign: { id: 4 }, ad_group: { id: 41 }, ad_group_criterion: { status: 'ENABLED', user_list: { user_list: 'customers/1/userLists/7' } } }],
    userLists: [list(7, 5000, false)],
  }, 30);
  const structuralCodes = structural.findings.map((f) => f.code);
  assert('display: campaign without any user list flagged', structuralCodes.includes('no_audience_attached'));
  assert('display: non-serving campaign flagged', structuralCodes.includes('campaign_not_serving'));
  assert('display: list not eligible for Display flagged', structuralCodes.includes('audience_not_eligible_for_display'));
  assert('display: paused ad group in enabled campaign flagged', structuralCodes.includes('ad_group_paused_in_enabled_campaign'));
  assert('display: critical findings sort first', structural.findings[0]?.severity === 'critical');

  // Nothing wrong: a serving campaign with a healthy list produces no findings.
  const healthy = analyzeDisplayRemarketing({
    campaigns: [{ campaign: { id: 5, name: 'Healthy', status: 'ENABLED', serving_status: 'SERVING', bidding_strategy_type: 'MANUAL_CPC' }, campaign_budget: { amount_micros: m(30) }, metrics: { impressions: 12000 } }],
    adGroups: [{ campaign: { id: 5 }, ad_group: { id: 51, name: 'AG', status: 'ENABLED', cpc_bid_micros: m(1.2) } }],
    audiences: [{ campaign: { id: 5 }, ad_group: { id: 51 }, ad_group_criterion: { status: 'ENABLED', user_list: { user_list: 'customers/1/userLists/6' } } }],
    userLists: [list(6, 25000, true)],
  }, 30);
  assert('display: healthy setup yields no findings', healthy.findings.length === 0, healthy.findings.map((f) => f.code).join(','));
}

async function main() {
  console.log('Smoke test: google-ads-baby MCP server\n');

  process.env['CLAUDE_PLUGIN_DATA'] = '/tmp/.gads-baby-test';

  await testConfig();
  await testSaveLoadConfig();
  await testAuthFlow();
  testAnalysis();
  testDisplayRemarketing();
  testLimitHelpers();
  testToolContract();
  await testCapEnforcement();

  console.log(`\n--- Results: ${passed} passed, ${failed} failed ---`);
  process.exit(failed > 0 ? 1 : 0);
}

main();
