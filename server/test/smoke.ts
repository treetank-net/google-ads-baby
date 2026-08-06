import { configFromEnv, saveConfig, loadSavedConfig, getConfigPath, getConfigDir } from '../src/config.js';
import { startAuthFlow, checkAuthStatus } from '../src/auth.js';
import { OAUTH_CLIENT_ID } from '../src/constants.js';
import { unlink } from 'fs/promises';
import { homedir, tmpdir } from 'os';
import { join } from 'path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerWriteTools } from '../src/tools/write.js';
import { updatedFieldNames } from '../src/history.js';
import {
  resolveAmountLimits,
  currencyUnitScale,
  formatAmount,
  formatUnits,
  CURRENCY_UNIT_SCALE,
  DEFAULT_MAX_BUDGET_UNITS,
  DEFAULT_MAX_CPC_UNITS,
  DEFAULT_MAX_TARGET_CPA_UNITS,
  MICROS_PER_UNIT,
} from '../src/tools/amounts.js';
import {
  AMOUNT_FIELD_LIMITS,
  amountFieldLimitError,
  budgetLimitError,
  cpcLimitError,
  targetCpaLimitError,
  changeLine,
  microsChangeLine,
  textChangeLines,
  manualBiddingRequiredWarning,
  enumName,
  sharedBudgetWarning,
  validateResponsiveDisplayText,
} from '../src/tools/write-helpers.js';
import {
  analyzeAccountHygiene,
  analyzeScalingCandidates,
  analyzeSearchTermsWaste,
  analyzePmaxBreakdown,
  analyzeDisplayRemarketing,
  rankAudienceCoverage,
  sortFindings,
  enumLabel,
  windowClause,
  scaleUnitThresholds,
  HYGIENE_DEFAULTS,
  DISPLAY_REMARKETING_DEFAULTS,
  MICROS,
} from '../src/tools/analysis-helpers.js';
import { enums } from 'google-ads-api';
import { registerReadTools } from '../src/tools/read.js';
import { registerAuthTools } from '../src/tools/auth.js';
import { TOOL_PROFILE, normalizeProfile, isToolAllowed, withProfile, profileNotice, type ToolProfile } from '../src/tools/profile.js';
import { PLUGIN_VERSION } from '../src/constants.js';
import { readFileSync } from 'fs';
import { toTsv, tsvDocument, decodeCell, shortenResourceName, trimPrecision, paginate, pageNote, flattenRow, DEFAULT_PAGE_CHARS } from '../src/tools/format.js';

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
const CAP_SWEEP_EXEMPT = new Set(['prepare_budget_change.current_budget_amount']);

const SMOKE_CFG = {
  clientId: '',
  clientSecret: '',
  developerToken: '',
  refreshToken: '',
  loginCustomerId: '',
  safetyLevel: 'standard',
  toolProfile: 'full',
  mutationTokenTtlSeconds: '',
  confirmStateTtlSeconds: '',
} as any;

function registeredForProfile(profile: ToolProfile): Record<string, any> {
  const server = new McpServer({ name: 'smoke', version: '0.0.0' });
  const target = withProfile(server, profile);
  const cfg = { ...SMOKE_CFG, toolProfile: profile };
  registerAuthTools(target, cfg);
  registerReadTools(target, cfg);
  registerWriteTools(target, cfg);
  return (server as any)._registeredTools as Record<string, any>;
}

function testProfiles() {
  console.log('\n--- Tool profiles ---');

  assert('unset profile defaults to full', normalizeProfile(undefined) === 'full');
  assert('unknown profile value falls back to full', normalizeProfile('everything') === 'full');
  assert('profile value is case- and space-insensitive', normalizeProfile('  Read ') === 'read');

  const full = registeredForProfile('full');
  const manage = registeredForProfile('manage');
  const read = registeredForProfile('read');

  const names = Object.keys(full);
  const unclassified = names.filter((n) => !(n in TOOL_PROFILE));
  assert('every registered tool is classified into a profile', unclassified.length === 0, unclassified.join(', '));
  const stale = Object.keys(TOOL_PROFILE).filter((n) => !names.includes(n));
  assert('the profile map has no entries for tools that no longer exist', stale.length === 0, stale.join(', '));

  assert('full registers everything', Object.keys(full).length === names.length);
  assert('manage registers fewer tools than full', Object.keys(manage).length < names.length);
  assert('read registers fewer tools than manage', Object.keys(read).length < Object.keys(manage).length);

  assert('read exposes no prepare_* tool', !Object.keys(read).some((n) => n.startsWith('prepare_')));
  assert('read exposes no confirm_* tool', !Object.keys(read).some((n) => n.startsWith('confirm_')));
  assert('read keeps the analysis tools', 'get_display_remarketing_diagnostics' in read && 'get_account_hygiene_report' in read);
  assert('read keeps auth so the user can still connect', 'setup_google_auth' in read);
  assert('read keeps mutation history for auditing', 'get_mutation_history' in read);

  assert('manage keeps the edit tools the field asked for', ['prepare_ad_group_update', 'prepare_campaign_update', 'prepare_ad_update', 'prepare_budget_change'].every((n) => n in manage));
  assert('manage keeps the confirm kernel', ['confirm_mutation', 'confirm_all_mutations', 'confirm_safe_word', 'get_safety_setup'].every((n) => n in manage));
  assert('manage excludes the composite builders', !Object.keys(manage).some((n) => n.endsWith('_full')));
  assert('manage excludes creation tools', !('prepare_search_campaign' in manage) && !('prepare_ad_group' in manage) && !('prepare_responsive_search_ad' in manage));
  assert('manage excludes asset tools', !Object.keys(manage).some((n) => n.includes('asset')));
  assert('manage excludes cloning', !('prepare_clone_entity' in manage));

  assert('a manage-level tool is allowed under full', isToolAllowed('prepare_budget_change', 'full'));
  assert('a full-level tool is refused under manage', !isToolAllowed('prepare_search_campaign_full', 'manage'));
  assert('an unknown tool name is allowed rather than silently hidden', isToolAllowed('some_future_tool', 'read'));

  assert('read profile states mutations are impossible', profileNotice('read').includes('mutations are impossible'));
  assert('manage profile names the env var needed to unlock creation', profileNotice('manage').includes('GOOGLE_ADS_BABY_PROFILE=full'));
  assert('full profile adds no notice', profileNotice('full') === '');

  const pkgVersion = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).version;
  assert('PLUGIN_VERSION matches package.json', PLUGIN_VERSION === pkgVersion, `constant=${PLUGIN_VERSION} package=${pkgVersion}`);
}

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

function testAccountCurrency() {
  console.log('\n--- Account currency and configurable caps ---');

  const pln = resolveAmountLimits(SMOKE_CFG, 'PLN');
  assert('PLN keeps the historical caps', pln.budgetMicros === DEFAULT_MAX_BUDGET_UNITS * MICROS_PER_UNIT
    && pln.cpcMicros === DEFAULT_MAX_CPC_UNITS * MICROS_PER_UNIT
    && pln.targetCpaMicros === DEFAULT_MAX_TARGET_CPA_UNITS * MICROS_PER_UNIT);

  const eur = resolveAmountLimits(SMOKE_CFG, 'EUR');
  assert('EUR cap is a quarter of the PLN cap', eur.budgetMicros === 125 * MICROS_PER_UNIT);
  const huf = resolveAmountLimits(SMOKE_CFG, 'HUF');
  assert('HUF cap scales up so it is not ~5 PLN', huf.budgetMicros === 50_000 * MICROS_PER_UNIT);
  const czk = resolveAmountLimits(SMOKE_CFG, 'CZK');
  assert('CZK cap scales up', czk.budgetMicros === 2_500 * MICROS_PER_UNIT);

  assert('currency code is case-insensitive', currencyUnitScale('eur') === currencyUnitScale('EUR'));
  assert('an unknown currency falls back to the strictest scale', currencyUnitScale('JPY') === 1);
  assert('every scale in the table is positive', Object.values(CURRENCY_UNIT_SCALE).every((s) => s > 0));

  const unknownCurrency = resolveAmountLimits(SMOKE_CFG, '');
  assert('an unreadable currency still caps at the default units', unknownCurrency.budgetMicros === DEFAULT_MAX_BUDGET_UNITS * MICROS_PER_UNIT);
  assert('an unreadable currency is not faked as PLN', unknownCurrency.currency === '');
  assert('amounts without a currency say so instead of lying', formatAmount(500_000_000, '').includes('account currency unit'));
  assert('amounts with a currency name it', formatAmount(500_000_000, 'EUR') === '500 EUR');
  assert('fractional amounts keep two decimals', formatAmount(1_230_000, 'CZK') === '1.23 CZK');

  const configured = resolveAmountLimits({ ...SMOKE_CFG, maxDailyBudgetUnits: '80', maxCpcUnits: '5' }, 'EUR');
  assert('a configured budget cap wins over the currency default', configured.budgetMicros === 80 * MICROS_PER_UNIT);
  assert('a configured CPC cap wins over the currency default', configured.cpcMicros === 5 * MICROS_PER_UNIT);
  assert('an unconfigured cap still scales by currency', configured.targetCpaMicros === 125 * MICROS_PER_UNIT);
  const garbage = resolveAmountLimits({ ...SMOKE_CFG, maxDailyBudgetUnits: 'unlimited' }, 'PLN');
  assert('a nonsense cap override is ignored, not treated as zero', garbage.budgetMicros === DEFAULT_MAX_BUDGET_UNITS * MICROS_PER_UNIT);
  const negative = resolveAmountLimits({ ...SMOKE_CFG, maxDailyBudgetUnits: '-10' }, 'PLN');
  assert('a negative cap override is ignored', negative.budgetMicros === DEFAULT_MAX_BUDGET_UNITS * MICROS_PER_UNIT);

  assert('the limit message names the account currency', (budgetLimitError(900, eur) ?? '').includes('EUR'));
  assert('the limit message no longer hardcodes PLN', !(budgetLimitError(900, eur) ?? '').includes('PLN'));
  assert('an amount within the local cap passes', budgetLimitError(100, eur) === null);
  assert('an amount over the local cap is rejected', (budgetLimitError(200, eur) ?? '').includes('safety limit'));
  assert('units render without a currency when it is unknown', formatUnits(12.5, '').includes('account currency unit'));

  // Diagnostic thresholds are money too: a PLN-tuned floor of 50 is ~0.5 PLN on a
  // HUF account, which would flag every campaign that ever spent anything.
  const hufThresholds = scaleUnitThresholds(HYGIENE_DEFAULTS, currencyUnitScale('HUF'));
  assert('cost thresholds scale with the currency', hufThresholds.noConvCostFloorUnits === 5_000);
  assert('ratio thresholds are left alone', hufThresholds.lowUtil === HYGIENE_DEFAULTS.lowUtil);
  const displayHuf = scaleUnitThresholds(DISPLAY_REMARKETING_DEFAULTS, currencyUnitScale('HUF'));
  assert('the low-CPC floor scales with the currency', displayHuf.lowCpcUnits === 10);
  assert('audience size is not a money threshold', displayHuf.minDisplayListSize === DISPLAY_REMARKETING_DEFAULTS.minDisplayListSize);
  assert('membership days are not a money threshold', displayHuf.shortMembershipDays === DISPLAY_REMARKETING_DEFAULTS.shortMembershipDays);
  assert('a PLN account keeps the original threshold object', scaleUnitThresholds(HYGIENE_DEFAULTS, 1) === HYGIENE_DEFAULTS);

  const smallHufSpend = [{ campaign: { id: 1, name: 'HU low spend' }, campaign_budget: { amount_micros: 20_000 * MICROS }, metrics: { cost_micros: 300 * MICROS, conversions: 0 } }];
  assert('a trivial HUF spend is not flagged as wasteful',
    !analyzeAccountHygiene(smallHufSpend, 30, hufThresholds).some((f) => f.code === 'spend_no_conversions'));
  assert('the same amount in PLN is flagged as wasteful',
    analyzeAccountHygiene(smallHufSpend, 30).some((f) => f.code === 'spend_no_conversions'));
}

function testLimitHelpers() {
  console.log('\n--- Mutation limit helpers ---');

  const limits = resolveAmountLimits(SMOKE_CFG, 'PLN');
  assert('budget at the cap is allowed', budgetLimitError(limits.budgetMicros / MICROS_PER_UNIT, limits) === null);
  assert('budget above the cap is rejected', (budgetLimitError(limits.budgetMicros / MICROS_PER_UNIT + 1, limits) ?? '').includes('safety limit'));
  assert('CPC at the cap is allowed', cpcLimitError(limits.cpcMicros / MICROS_PER_UNIT, limits) === null);
  assert('CPC above the cap is rejected', (cpcLimitError(limits.cpcMicros / MICROS_PER_UNIT + 0.01, limits) ?? '').includes('safety limit'));
  assert('target CPA at the cap is allowed', targetCpaLimitError(limits.targetCpaMicros / MICROS_PER_UNIT, limits) === null);
  assert('target CPA above the cap is rejected', (targetCpaLimitError(limits.targetCpaMicros / MICROS_PER_UNIT + 1, limits) ?? '').includes('safety limit'));

  // Nested payloads (the *_full tools) must be walked, not just top-level fields.
  const nested = { customer_id: '1', daily_budget_amount: 100, ad_groups: [{ name: 'a', cpc_bid_amount: 2 }, { name: 'b', cpc_bid_amount: 9999 }] };
  const nestedError = amountFieldLimitError(nested, limits) ?? '';
  assert('nested cpc_bid_amount over the cap is caught', nestedError.includes('safety limit'));
  assert('nested error names the offending path', nestedError.includes('ad_groups[1].cpc_bid_amount'));
  assert('clean nested payload passes', amountFieldLimitError({ daily_budget_amount: 10, ad_groups: [{ cpc_bid_amount: 3 }] }, limits) === null);
  assert('deeply nested bidding target is caught', (amountFieldLimitError({ bidding: { target_cpa_amount: 100000 } }, limits) ?? '').includes('Target CPA'));
  const czkLimits = resolveAmountLimits(SMOKE_CFG, 'CZK');
  assert('a nested amount legal on a CZK account is not rejected', amountFieldLimitError({ daily_budget_amount: 1_500 }, czkLimits) === null);
  assert('the same nested amount is rejected on a PLN account', (amountFieldLimitError({ daily_budget_amount: 1_500 }, limits) ?? '').includes('safety limit'));

  assert('before -> after keeps both values', changeLine('Status', 'PAUSED', 'ENABLED') === 'Status: PAUSED → ENABLED');
  assert('missing previous value is explicit', changeLine('Name', undefined, 'x').includes('(not set)'));
  assert('12x bid increase is called out', microsChangeLine('Max CPC', 200_000, 2_500_000, 'PLN').includes('12.5x more'));
  assert('halving is called out as less', microsChangeLine('Max CPC', 2_000_000, 500_000, 'PLN').includes('4.0x less'));
  assert('small change shows percent', microsChangeLine('Daily budget', 100_000_000, 110_000_000, 'PLN').includes('+10%'));
  assert('unknown previous amount degrades gracefully', microsChangeLine('Max CPC', undefined, 1_000_000, 'PLN').includes('(not set)'));
  assert('before -> after carries the account currency', microsChangeLine('Daily budget', 40_000_000, 60_000_000, 'CZK').includes('CZK'));

  assert('manual CPC needs no bidding warning', manualBiddingRequiredWarning('MANUAL_CPC') === null);
  assert('enhanced CPC honours ad group bids, so no warning', manualBiddingRequiredWarning('ENHANCED_CPC') === null);
  assert('automated bidding warns that CPC is ignored', (manualBiddingRequiredWarning('MAXIMIZE_CONVERSIONS') ?? '').includes('will not affect delivery'));
  assert('CPM bidding warns that CPC is ignored', (manualBiddingRequiredWarning('MANUAL_CPM') ?? '').includes('will not affect delivery'));
  assert('a raw enum number never reaches the bidding warning', manualBiddingRequiredWarning(enumName(enums.BiddingStrategyType as any, 3)) === null);
  assert('enumName maps ad types to names', enumName(enums.AdType as any, 19) === 'RESPONSIVE_DISPLAY_AD');
  assert('enumName maps ad group status to names', enumName(enums.AdGroupStatus as any, 3) === 'PAUSED');
  assert('enumName leaves an unknown value visible', enumName(enums.AdGroupStatus as any, 987) === '987');
  assert('unshared budget needs no warning', sharedBudgetWarning(1, false) === null);
  assert('shared budget warns about other campaigns', (sharedBudgetWarning(3, true) ?? '').includes('shared by 3 campaigns'));
  // A shared-type budget used by exactly one campaign used to read "shared by 1
  // campaign(s) ... affects every campaign using it, not only this one", which
  // contradicts itself. Seen live on the sandbox account.
  const soleUser = sharedBudgetWarning(1, true) ?? '';
  assert('a shared budget with one user does not claim other campaigns are affected', !soleUser.includes('not only this one'));
  assert('a shared budget with one user still says it is a shared resource', soleUser.includes('shared budget resource'));
  assert('an unshared budget with a stale count of 0 stays silent', sharedBudgetWarning(0, false) === null);

  assert('amounts in a change line always keep two decimals', microsChangeLine('Daily budget', 1_000_000, 3_500_000, 'PLN').startsWith('Daily budget: 1.00 PLN → 3.50 PLN'));
  assert('cap messages keep whole numbers readable', (budgetLimitError(9999, resolveAmountLimits(SMOKE_CFG, 'PLN')) ?? '').includes('(500 PLN/day)'));

  const textLines = textChangeLines('Descriptions', ['Paused test ad', 'File-path assets test'], ['Paused test ad', 'Currency preview check']);
  assert('text changes show the previous values, not just the count', textLines.join('\n').includes('File-path assets test'));
  assert('text changes mark what is removed', textLines.some((l) => l.includes('- File-path assets test')));
  assert('text changes mark what is added', textLines.some((l) => l.includes('+ Currency preview check')));
  assert('text changes mark what is kept', textLines.some((l) => l.includes('= Paused test ad')));
  assert('emptying a list is explicit', textChangeLines('Headlines', ['a'], []).join('\n').includes('(none)'));

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
  for (const [createField, updateField] of [['cpc_bid_amount', 'cpc_bid_amount'], ['ad_group_name', 'name'], ['optimized_targeting_enabled', 'optimized_targeting_enabled']]) {
    assert(`ad group create field ${createField} has an update path`, adGroupUpdateFields.includes(updateField));
  }
  const campaignUpdateFields = toolFieldNames(tools['prepare_campaign_update']);
  for (const [createField, updateField] of [['campaign_name', 'name'], ['daily_budget_amount', 'daily_budget_amount'], ['status', 'status']]) {
    assert(`campaign create field ${createField} has an update path`, campaignUpdateFields.includes(updateField));
  }

  // Any *_amount field must match a known limit rule; a field that only hits the
  // fallback is a cap waiting to be forgotten.
  const unmatched: string[] = [];
  for (const [toolName, tool] of Object.entries(tools)) {
    for (const field of toolFieldNames(tool)) {
      if (!field.endsWith('_amount')) continue;
      if (!AMOUNT_FIELD_LIMITS.some((rule) => rule.match.test(field))) unmatched.push(`${toolName}.${field}`);
    }
  }
  assert('every *_amount field maps to a limit rule', unmatched.length === 0, unmatched.join(', '));
}

async function testCapEnforcement() {
  console.log('\n--- Cap enforcement (every money field, every tool) ---');

  const tools = registeredWriteTools();
  const skipped: string[] = [];
  let checked = 0;

  for (const [toolName, tool] of Object.entries(tools)) {
    for (const field of toolFieldNames(tool)) {
      if (!field.endsWith('_amount')) continue;
      const key = `${toolName}.${field}`;
      if (CAP_SWEEP_EXEMPT.has(key)) {
        skipped.push(key);
        continue;
      }
      const args: Record<string, unknown> = { customer_id: '1234567890', safe_word: 'smoke', [field]: 10_000_000 };
      if (toolFieldNames(tool).includes('campaign_id')) args['campaign_id'] = '1';
      if (toolFieldNames(tool).includes('ad_group_id')) args['ad_group_id'] = '1';
      if (toolFieldNames(tool).includes('budget_id')) args['budget_id'] = '1';
      if (field === 'target_cpa_amount') args['strategy_type'] = 'TARGET_CPA';
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

function testFormat() {
  console.log('\n--- Compact TSV output ---');

  const rows = [
    { campaign: { resource_name: 'customers/1/campaigns/10', id: 10, name: 'CZ | TFC | LMT | DISPLAY', status: 3, advertising_channel_type: 3 } },
    { campaign: { resource_name: 'customers/1/campaigns/11', id: 11, name: 'Healthy', status: 2, advertising_channel_type: 2 } },
  ];
  const tsv = toTsv(rows);
  const lines = tsv.split('\n');
  assert('tsv writes the header once', lines.length === 3);
  assert('tsv drops resource_name', !tsv.includes('resource_name') && !tsv.includes('customers/1/campaigns'));
  assert('tsv decodes campaign status', lines[1].includes('PAUSED') && lines[2].includes('ENABLED'));
  assert('tsv decodes channel type', lines[1].includes('DISPLAY') && lines[2].includes('SEARCH'));
  assert('tsv keeps pipes in names intact', lines[1].includes('CZ | TFC | LMT | DISPLAY'));
  assert('tsv is smaller than json', tsv.length < JSON.stringify(rows, null, 2).length);

  const refs = toTsv([{ ad_group: { id: 5, campaign: 'customers/1/campaigns/10' } }]);
  assert('tsv shortens a resource reference to its id', refs.split('\n')[1] === '5\t10');

  const creative = toTsv([{
    ad_group_ad: {
      ad: { id: 7, type: 19, final_urls: ['https://a.example/x'], responsive_display_ad: { headlines: [{ text: 'One' }, { text: 'Two' }] } },
    },
  }]);
  assert('tsv joins repeated text fields', creative.includes('One ~ Two'));
  assert('tsv decodes ad type', creative.includes('RESPONSIVE_DISPLAY_AD'));

  const messy = toTsv([{ campaign: { id: 1, name: 'has\ta tab\nand a newline' } }]);
  assert('tsv neutralises tabs and newlines inside values', messy.split('\n').length === 2 && messy.split('\n')[1] === '1\thas a tab and a newline');

  const sparse = toTsv([{ a: 1 }, { b: 2 }]);
  assert('tsv unions columns across rows', sparse.split('\n')[0] === 'a\tb' && sparse.split('\n')[2] === '\t2');

  assert('empty input yields no table', toTsv([]) === '');
  assert('tsvDocument labels an empty section', tsvDocument([['ads', []]]).includes('## ads (0)'));
  const doc = tsvDocument([['campaigns', rows]], ['# header']);
  assert('tsvDocument keeps the header and explains the format', doc.startsWith('# header') && doc.includes('tab-separated'));

  assert('unknown enum columns are left alone', decodeCell('campaign.some_future_field', 7) === 7);
  assert('an out-of-range enum keeps its number', decodeCell('campaign.status', 999) === 999);
  assert('already-decoded names pass through', decodeCell('campaign.status', 'ENABLED') === 'ENABLED');
  assert('non-resource strings are untouched', shortenResourceName('Transport CPM') === 'Transport CPM');

  assert('float precision is trimmed to what is meaningful', trimPrecision(0.12375415282392027) === 0.123754);
  assert('integers keep every digit', trimPrecision(624362494) === 624362494);
  assert('micros are never rounded', toTsv([{ metrics: { cost_micros: 624362494, ctr: 0.024426496464442234 } }]).split('\n')[1] === '624362494\t0.0244265');
  assert('small floats survive trimming', trimPrecision(0.0000123456789) === 0.0000123457);

  assert('an empty repeated field adds no column', !('final_urls' in flattenRow({ ad: { id: 1, final_urls: [] } })));
}

function testPagination() {
  console.log('\n--- Pagination by response size ---');

  const small = Array.from({ length: 5 }, (_, i) => ({ campaign: { id: i, name: 'x' } }));
  const onePage = paginate(small, 1);
  assert('a small result is one page', onePage.pages === 1 && onePage.rows.length === 5);
  assert('one page emits no note', pageNote(onePage, 'campaigns') === undefined);

  const wide = Array.from({ length: 400 }, (_, i) => ({ ad_group_ad: { ad: { id: i, name: 'y'.repeat(500) } } }));
  const p1 = paginate(wide, 1);
  assert('an oversized result splits into several pages', p1.pages > 2, `pages=${p1.pages}`);
  assert('a page fits the character budget', toTsv(p1.rows).length <= DEFAULT_PAGE_CHARS, `chars=${toTsv(p1.rows).length}`);
  assert('total counts every row, not the page', p1.total === 400);

  const p2 = paginate(wide, 2);
  assert('the next page continues where the last ended', p2.from === p1.to + 1);

  const last = paginate(wide, p1.pages);
  assert('the last page ends on the last row', last.to === 400);
  assert('a page past the end clamps to the last one', paginate(wide, 999).page === p1.pages);
  assert('page 0 clamps to the first page', paginate(wide, 0).page === 1);

  const seen = new Set<number>();
  for (let i = 1; i <= p1.pages; i++) {
    for (const row of paginate(wide, i).rows) seen.add((row as any).ad_group_ad.ad.id);
  }
  assert('no row is lost or duplicated across pages', seen.size === 400);

  const note = pageNote(p1, 'ads');
  assert('the note says which page of how many', !!note && note.includes(`of ${p1.pages}`) && note.includes('of 400'));
  assert('the note tells the caller how to continue', !!note && note.includes('page: 2'));
  assert('the last page says it is last', String(pageNote(last, 'ads')).includes('last page'));

  assert('a tighter budget yields more pages', paginate(wide, 1, 8_000).pages > p1.pages);
  assert('narrow rows need fewer pages than wide ones', paginate(Array.from({ length: 400 }, (_, i) => ({ campaign: { id: i } })), 1).pages < p1.pages);
  assert('an empty result is a single empty page', paginate([], 1).pages === 1 && paginate([], 1).total === 0);

  const asJson = paginate(Array.from({ length: 200 }, (_, i) => ({ code: 'x', entity: `e${i}`, blob: 'z'.repeat(300) })), 1, 10_000, (rows) => JSON.stringify(rows, null, 2));
  assert('pagination honours a non-TSV renderer', JSON.stringify(asJson.rows, null, 2).length <= 10_000 && asJson.pages > 1);
}

function displayTaskStub() {
  return { title: 't', intent: 'i', suggested_workflow: 'w', source_type: 'review' as const, reason: 'r' };
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

  // GAQL returns enums as numbers, not names. Everything above must still hold
  // when the rows look the way the API actually returns them.
  const numericEnums = analyzeDisplayRemarketing({
    campaigns: [{
      campaign: { id: 6, name: 'Numeric', status: 2, serving_status: 5, bidding_strategy_type: 3 } as any,
      campaign_budget: { amount_micros: m(30) },
      metrics: { impressions: 0 },
    }],
    adGroups: [
      { campaign: { id: 6 }, ad_group: { id: 61, name: 'Paused AG', status: 3, cpc_bid_micros: m(1) } as any },
      { campaign: { id: 6 }, ad_group: { id: 62, name: 'Cheap AG', status: 2, cpc_bid_micros: 50_000 } as any },
    ],
    audiences: [{ campaign: { id: 6 }, ad_group: { id: 62 }, ad_group_criterion: { status: 'ENABLED', user_list: { user_list: 'customers/1/userLists/5' } } }],
    userLists: [list(5, 40, true)],
  }, 30);
  const numericCodes = numericEnums.findings.map((f) => f.code);
  assert('display: numeric CampaignStatus decoded as ENABLED', numericCodes.includes('zero_impressions'));
  assert('display: numeric serving_status decoded and flagged', numericCodes.includes('campaign_not_serving'));
  assert('display: numeric AdGroupStatus decoded as PAUSED', numericCodes.includes('ad_group_paused_in_enabled_campaign'));
  assert('display: numeric MANUAL_CPC decoded, low bid flagged', numericCodes.includes('manual_cpc_below_floor'));
  assert('display: numeric MANUAL_CPC produces no bids-are-ignored note', !numericCodes.includes('bids_not_the_constraint'));

  // The same list attached to several campaigns must yield one finding, not one per campaign.
  const sharedList = analyzeDisplayRemarketing({
    campaigns: [
      { campaign: { id: 7, name: 'A', status: 2, serving_status: 2, bidding_strategy_type: 3 } as any, campaign_budget: { amount_micros: m(30) }, metrics: { impressions: 500 } },
      { campaign: { id: 8, name: 'B', status: 2, serving_status: 2, bidding_strategy_type: 3 } as any, campaign_budget: { amount_micros: m(30) }, metrics: { impressions: 500 } },
      { campaign: { id: 9, name: 'C', status: 3, serving_status: 2, bidding_strategy_type: 3 } as any, campaign_budget: { amount_micros: m(30) }, metrics: { impressions: 0 } },
    ],
    adGroups: [],
    audiences: [7, 8, 9].map((cid) => ({ campaign: { id: cid }, ad_group: { id: cid * 10 }, ad_group_criterion: { status: 'ENABLED', user_list: { user_list: 'customers/1/userLists/4' } } })),
    userLists: [list(4, 40, true)],
  }, 30);
  const undersized = sharedList.findings.filter((f) => f.code === 'audience_below_display_minimum');
  assert('display: one finding per list, not per campaign', undersized.length === 1, `got ${undersized.length}`);
  assert('display: finding records how many campaigns use the list', undersized[0]?.metrics.campaigns === 3);
  assert('display: coverage deduplicated to one row per list', sharedList.audience_coverage.length === 1);

  // A list used only by paused campaigns is not a live emergency.
  const pausedOnly = analyzeDisplayRemarketing({
    campaigns: [{ campaign: { id: 10, name: 'Paused', status: 3, serving_status: 2, bidding_strategy_type: 3 } as any, campaign_budget: { amount_micros: m(30) }, metrics: { impressions: 0 } }],
    adGroups: [],
    audiences: [{ campaign: { id: 10 }, ad_group: { id: 101 }, ad_group_criterion: { status: 'ENABLED', user_list: { user_list: 'customers/1/userLists/3' } } }],
    userLists: [list(3, 40, true)],
  }, 30);
  assert(
    'display: undersized list in paused campaigns downgraded to info',
    pausedOnly.findings.find((f) => f.code === 'audience_below_display_minimum')?.severity === 'info',
  );

  // Google reports 0 Display users for list types it does not size; that is not evidence of an empty audience.
  const unreported = analyzeDisplayRemarketing({
    campaigns: [{ campaign: { id: 11, name: 'YT list', status: 2, serving_status: 2, bidding_strategy_type: 3 } as any, campaign_budget: { amount_micros: m(30) }, metrics: { impressions: 900 } }],
    adGroups: [],
    audiences: [{ campaign: { id: 11 }, ad_group: { id: 111 }, ad_group_criterion: { status: 'ENABLED', user_list: { user_list: 'customers/1/userLists/2' } } }],
    userLists: [{ user_list: { id: 2, name: 'YT 540d', resource_name: 'customers/1/userLists/2', size_for_display: 0, size_for_search: 540_000, eligible_for_display: true, membership_life_span: 540 } }],
  }, 30);
  const unreportedCodes = unreported.findings.map((f) => f.code);
  assert('display: unsized Display list is not called undersized', !unreportedCodes.includes('audience_below_display_minimum'));
  assert('display: unsized Display list reported as info', unreported.findings.find((f) => f.code === 'display_size_not_reported')?.severity === 'info');

  const coverage = Array.from({ length: 45 }, (_, index) => ({ user_list: `l${index}`, enabled_campaigns: index }));
  const rankedCoverage = rankAudienceCoverage(coverage);
  assert('display: coverage keeps every list (nothing dropped)', rankedCoverage.length === 45);
  assert('display: coverage is ordered by enabled campaigns', Number(rankedCoverage[0].enabled_campaigns) === 44);
  assert('display: ranking does not mutate the input', Number(coverage[0].enabled_campaigns) === 0);

  const many = [
    ...Array.from({ length: 4 }, (_, i) => ({ code: 'c', severity: 'critical' as const, entity: `c${i}`, observation: '', metrics: {}, suggested_task: displayTaskStub(), prepare_actions: [] })),
    ...Array.from({ length: 30 }, (_, i) => ({ code: 'i', severity: 'info' as const, entity: `i${i}`, observation: '', metrics: {}, suggested_task: displayTaskStub(), prepare_actions: [] })),
  ];
  const rankedFindings = sortFindings(many);
  assert('findings are ordered most severe first', rankedFindings.slice(0, 4).every((f) => f.severity === 'critical'));
  const findingsPage = paginate(rankedFindings, 1, 4_000, (rows) => JSON.stringify(rows, null, 2));
  assert('findings paginate instead of being capped', findingsPage.pages > 1 && findingsPage.total === 34);
  assert('page 1 of findings carries the criticals', findingsPage.rows.filter((f) => f.severity === 'critical').length === 4);
  const seenFindings = new Set<string>();
  for (let i = 1; i <= findingsPage.pages; i++) {
    for (const f of paginate(rankedFindings, i, 4_000, (rows) => JSON.stringify(rows, null, 2)).rows) seenFindings.add(f.entity);
  }
  assert('every finding is reachable across pages', seenFindings.size === 34);

  assert('enumLabel maps a number to its name', enumLabel(enums.CampaignStatus as any, 2) === 'ENABLED');
  assert('enumLabel passes a name through', enumLabel(enums.CampaignStatus as any, 'PAUSED') === 'PAUSED');
  assert('enumLabel leaves an unknown value visible', enumLabel(enums.CampaignStatus as any, 999) === '999');
  assert('enumLabel treats missing as empty', enumLabel(enums.CampaignStatus as any, undefined) === '');
}

async function main() {
  console.log('Smoke test: google-ads-baby MCP server\n');

  process.env['GOOGLE_ADS_BABY_DATA'] = join(tmpdir(), '.gads-baby-test');
  if (getConfigDir() === join(homedir(), '.google-ads-baby')) {
    console.log('  ABORT  refusing to run: the suite would write to the real config directory');
    process.exit(1);
  }

  await testConfig();
  await testSaveLoadConfig();
  await testAuthFlow();
  testAnalysis();
  testFormat();
  testPagination();
  testProfiles();
  testDisplayRemarketing();
  testAccountCurrency();
  testLimitHelpers();
  testToolContract();
  await testCapEnforcement();

  console.log(`\n--- Results: ${passed} passed, ${failed} failed ---`);
  process.exit(failed > 0 ? 1 : 0);
}

main();
