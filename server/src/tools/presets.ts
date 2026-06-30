import type {
  SearchCampaignBidding,
  SearchCampaignFullPayload,
  DisplayCampaignFullPayload,
  PerformanceMaxCampaignFullPayload,
} from '../client/campaigns.js';

const PLN_TO_MICROS = 1_000_000;
const DEFAULT_CPC_MICROS = 1 * PLN_TO_MICROS;

const GEO_POLAND = '2616';
const LANG_POLISH = '1045';

export type SearchPreset = 'ecommerce-search-pl' | 'leadgen-search-pl' | 'none';

interface PresetDefaults {
  matchTypes: Array<'EXACT' | 'PHRASE' | 'BROAD'>;
  bidding: SearchCampaignBidding;
  locationCriterionIds: string[];
  languageCriterionIds: string[];
  positiveGeoTargetType: 'PRESENCE' | 'PRESENCE_OR_INTEREST';
}

const GLOBAL_DEFAULTS: PresetDefaults = {
  matchTypes: ['EXACT', 'PHRASE'],
  bidding: { type: 'MANUAL_CPC' },
  locationCriterionIds: [],
  languageCriterionIds: [],
  positiveGeoTargetType: 'PRESENCE',
};

const SEARCH_PRESETS: Record<Exclude<SearchPreset, 'none'>, PresetDefaults> = {
  'ecommerce-search-pl': {
    matchTypes: ['EXACT', 'PHRASE'],
    bidding: { type: 'MAXIMIZE_CONVERSION_VALUE' },
    locationCriterionIds: [GEO_POLAND],
    languageCriterionIds: [LANG_POLISH],
    positiveGeoTargetType: 'PRESENCE',
  },
  'leadgen-search-pl': {
    matchTypes: ['EXACT', 'PHRASE'],
    bidding: { type: 'MAXIMIZE_CONVERSIONS' },
    locationCriterionIds: [GEO_POLAND],
    languageCriterionIds: [LANG_POLISH],
    positiveGeoTargetType: 'PRESENCE',
  },
};

export function listSearchPresets(): Array<{ id: string; bidding: string; geo: string; matchTypes: string }> {
  return Object.entries(SEARCH_PRESETS).map(([id, p]) => ({
    id,
    bidding: p.bidding.type,
    geo: `${p.locationCriterionIds.join(',')} (${p.positiveGeoTargetType})`,
    matchTypes: p.matchTypes.join('+'),
  }));
}

export interface SearchCampaignFullInput {
  preset?: SearchPreset;
  campaignName: string;
  dailyBudgetMicros: number;
  finalUrl: string;
  status?: 'PAUSED' | 'ENABLED';
  defaultCpcBidMicros?: number;
  adGroups: Array<{
    name: string;
    cpcBidMicros?: number;
    finalUrl?: string;
    keywords: Array<{ text: string; matchType?: 'EXACT' | 'PHRASE' | 'BROAD' }>;
    headlines: string[];
    descriptions: string[];
  }>;
  locationCriterionIds?: string[];
  languageCriterionIds?: string[];
  positiveGeoTargetType?: 'PRESENCE' | 'PRESENCE_OR_INTEREST';
  bidding?: SearchCampaignBidding;
  campaignNegatives?: Array<{ text: string; matchType?: 'EXACT' | 'PHRASE' | 'BROAD' }>;
  sitelinks?: Array<{ linkText: string; description1?: string; description2?: string; finalUrl?: string }>;
  callouts?: string[];
  call?: { countryCode: string; phoneNumber: string };
}

export function buildSearchCampaignPayload(input: SearchCampaignFullInput): SearchCampaignFullPayload {
  const preset = input.preset && input.preset !== 'none' ? SEARCH_PRESETS[input.preset] : GLOBAL_DEFAULTS;
  const defaultCpc = input.defaultCpcBidMicros ?? DEFAULT_CPC_MICROS;

  const expandKeywords = (keywords: SearchCampaignFullInput['adGroups'][number]['keywords']) =>
    keywords.flatMap((kw) =>
      kw.matchType
        ? [{ text: kw.text, matchType: kw.matchType }]
        : preset.matchTypes.map((matchType) => ({ text: kw.text, matchType })),
    );

  return {
    campaignName: input.campaignName,
    dailyBudgetMicros: input.dailyBudgetMicros,
    status: input.status ?? 'PAUSED',
    bidding: input.bidding ?? preset.bidding,
    locationCriterionIds: input.locationCriterionIds ?? preset.locationCriterionIds,
    languageCriterionIds: input.languageCriterionIds ?? preset.languageCriterionIds,
    positiveGeoTargetType: input.positiveGeoTargetType ?? preset.positiveGeoTargetType,
    campaignNegatives: (input.campaignNegatives ?? []).map((n) => ({ text: n.text, matchType: n.matchType ?? 'PHRASE' })),
    adGroups: input.adGroups.map((ag) => ({
      name: ag.name,
      cpcBidMicros: ag.cpcBidMicros ?? defaultCpc,
      keywords: expandKeywords(ag.keywords),
      headlines: ag.headlines,
      descriptions: ag.descriptions,
      finalUrl: ag.finalUrl ?? input.finalUrl,
    })),
    sitelinks: (input.sitelinks ?? []).map((s) => ({
      linkText: s.linkText,
      description1: s.description1 ?? '',
      description2: s.description2 ?? '',
      finalUrl: s.finalUrl ?? input.finalUrl,
    })),
    callouts: input.callouts ?? [],
    call: input.call,
  };
}

function formatBidding(bidding: SearchCampaignBidding): string {
  switch (bidding.type) {
    case 'TARGET_CPA':
      return `Target CPA ${((bidding.targetCpaMicros ?? 0) / PLN_TO_MICROS).toFixed(2)} PLN`;
    case 'TARGET_ROAS':
      return `Target ROAS ${((bidding.targetRoas ?? 0) * 100).toFixed(0)}%`;
    case 'MAXIMIZE_CONVERSION_VALUE':
      return bidding.targetRoas ? `Maximize conversion value (tROAS ${((bidding.targetRoas) * 100).toFixed(0)}%)` : 'Maximize conversion value';
    case 'MAXIMIZE_CONVERSIONS':
      return bidding.targetCpaMicros ? `Maximize conversions (tCPA ${((bidding.targetCpaMicros) / PLN_TO_MICROS).toFixed(2)} PLN)` : 'Maximize conversions';
    case 'MANUAL_CPC':
    default:
      return 'Manual CPC';
  }
}

export function formatSearchCampaignPreview(customerId: string, p: SearchCampaignFullPayload): string {
  const pln = (micros: number) => `${(micros / PLN_TO_MICROS).toFixed(2)} PLN`;
  const lines: string[] = [];
  lines.push(`Create SEARCH campaign "${p.campaignName}" on account ${customerId}`);
  lines.push(`Status: ${p.status}`);
  lines.push(`Daily budget: ${pln(p.dailyBudgetMicros)}`);
  lines.push(`Bidding: ${formatBidding(p.bidding)}`);
  if (p.locationCriterionIds.length) lines.push(`Geo targets: ${p.locationCriterionIds.join(', ')} (${p.positiveGeoTargetType})`);
  if (p.languageCriterionIds.length) lines.push(`Languages: ${p.languageCriterionIds.join(', ')}`);
  if (p.campaignNegatives.length) {
    lines.push(`Campaign negatives: ${p.campaignNegatives.map((n) => `${n.text} [${n.matchType}]`).join(', ')}`);
  }
  lines.push('');
  lines.push(`Ad groups (${p.adGroups.length}):`);
  for (const ag of p.adGroups) {
    lines.push(`- "${ag.name}" — CPC ${pln(ag.cpcBidMicros)}`);
    lines.push(`    Keywords (${ag.keywords.length}): ${ag.keywords.map((k) => `${k.text} [${k.matchType}]`).join(', ')}`);
    lines.push(`    RSA: ${ag.headlines.length} headlines / ${ag.descriptions.length} descriptions → ${ag.finalUrl}`);
  }
  const extensions: string[] = [];
  if (p.sitelinks.length) extensions.push(`${p.sitelinks.length} sitelink(s)`);
  if (p.callouts.length) extensions.push(`${p.callouts.length} callout(s)`);
  if (p.call) extensions.push('1 call');
  if (extensions.length) {
    lines.push('');
    lines.push(`Extensions: ${extensions.join(', ')}`);
  }
  lines.push('');
  lines.push('All of the above is created in ONE atomic transaction (all-or-nothing) and confirmed with a SINGLE safe word.');
  lines.push('Verify the details before confirming. After execution, check the campaign in the Google Ads panel.');
  return lines.join('\n');
}

export interface DisplayCampaignFullInput {
  campaignName: string;
  dailyBudgetMicros: number;
  status?: 'PAUSED' | 'ENABLED';
  bidding?: SearchCampaignBidding;
  locationCriterionIds?: string[];
  languageCriterionIds?: string[];
  positiveGeoTargetType?: 'PRESENCE' | 'PRESENCE_OR_INTEREST';
  adGroup: { name: string; cpcBidMicros?: number; optimizedTargetingEnabled?: boolean };
  ad: DisplayCampaignFullPayload['ad'];
}

export function buildDisplayCampaignPayload(input: DisplayCampaignFullInput): DisplayCampaignFullPayload {
  return {
    campaignName: input.campaignName,
    dailyBudgetMicros: input.dailyBudgetMicros,
    status: input.status ?? 'PAUSED',
    bidding: input.bidding ?? { type: 'MANUAL_CPC' },
    locationCriterionIds: input.locationCriterionIds ?? [GEO_POLAND],
    languageCriterionIds: input.languageCriterionIds ?? [LANG_POLISH],
    positiveGeoTargetType: input.positiveGeoTargetType ?? 'PRESENCE',
    adGroup: {
      name: input.adGroup.name,
      cpcBidMicros: input.adGroup.cpcBidMicros ?? DEFAULT_CPC_MICROS,
      optimizedTargetingEnabled: input.adGroup.optimizedTargetingEnabled,
    },
    ad: input.ad,
  };
}

export function formatDisplayCampaignPreview(customerId: string, p: DisplayCampaignFullPayload): string {
  const pln = (micros: number) => `${(micros / PLN_TO_MICROS).toFixed(2)} PLN`;
  const lines: string[] = [];
  lines.push(`Create DISPLAY campaign "${p.campaignName}" on account ${customerId}`);
  lines.push(`Status: ${p.status}`);
  lines.push(`Daily budget: ${pln(p.dailyBudgetMicros)}`);
  lines.push(`Bidding: ${formatBidding(p.bidding)}`);
  if (p.locationCriterionIds.length) lines.push(`Geo targets: ${p.locationCriterionIds.join(', ')} (${p.positiveGeoTargetType})`);
  if (p.languageCriterionIds.length) lines.push(`Languages: ${p.languageCriterionIds.join(', ')}`);
  lines.push('');
  lines.push(`Ad group: "${p.adGroup.name}" — CPC ${pln(p.adGroup.cpcBidMicros)}`);
  lines.push(`Responsive display ad: ${p.ad.headlines.length} headlines, ${p.ad.descriptions.length} descriptions, business "${p.ad.businessName}" → ${p.ad.finalUrl}`);
  lines.push(`Images: ${p.ad.marketingImageAssetIds.length} marketing, ${p.ad.squareMarketingImageAssetIds.length} square, ${p.ad.logoImageAssetIds.length} logo (existing asset IDs)`);
  lines.push('');
  lines.push('All of the above is created in ONE atomic transaction (all-or-nothing) and confirmed with a SINGLE safe word.');
  lines.push('Verify the details before confirming. After execution, check the campaign in the Google Ads panel.');
  return lines.join('\n');
}

export interface PerformanceMaxCampaignFullInput {
  campaignName: string;
  dailyBudgetMicros: number;
  status?: 'PAUSED' | 'ENABLED';
  targetRoas?: number;
  optOutAiEnhancements?: boolean;
  assetGroupName: string;
  finalUrls: string[];
  businessName?: string;
  headlines: string[];
  longHeadlines: string[];
  descriptions: string[];
  imageAssets: Array<{ assetId: string; fieldType: string }>;
  audienceSignals?: Array<{ type: 'SEARCH_THEME'; text: string } | { type: 'AUDIENCE'; audienceId: string }>;
}

export function buildPerformanceMaxPayload(input: PerformanceMaxCampaignFullInput): PerformanceMaxCampaignFullPayload {
  return {
    campaignName: input.campaignName,
    dailyBudgetMicros: input.dailyBudgetMicros,
    status: input.status ?? 'PAUSED',
    targetRoas: input.targetRoas,
    optOutAiEnhancements: input.optOutAiEnhancements ?? true,
    assetGroupName: input.assetGroupName,
    finalUrls: input.finalUrls,
    businessName: input.businessName,
    headlines: input.headlines,
    longHeadlines: input.longHeadlines,
    descriptions: input.descriptions,
    imageAssets: input.imageAssets,
    audienceSignals: input.audienceSignals ?? [],
  };
}

export function formatPmaxCampaignPreview(customerId: string, p: PerformanceMaxCampaignFullPayload): string {
  const pln = (micros: number) => `${(micros / PLN_TO_MICROS).toFixed(2)} PLN`;
  const lines: string[] = [];
  lines.push(`Create PERFORMANCE MAX campaign "${p.campaignName}" on account ${customerId}`);
  lines.push(`Status: ${p.status}`);
  lines.push(`Daily budget: ${pln(p.dailyBudgetMicros)}`);
  lines.push(`Bidding: ${p.targetRoas ? `Maximize conversion value (tROAS ${(p.targetRoas * 100).toFixed(0)}%)` : 'Maximize conversion value'}`);
  lines.push(`AI asset enhancements: ${p.optOutAiEnhancements ? 'OFF (opted out: text + final URL expansion)' : 'ON (Google defaults)'}`);
  lines.push('');
  lines.push(`Asset group: "${p.assetGroupName}" → ${p.finalUrls.join(', ')}`);
  lines.push(`Text assets: ${p.headlines.length} headlines, ${p.longHeadlines.length} long headlines, ${p.descriptions.length} descriptions${p.businessName ? ', business name' : ''}`);
  lines.push(`Image assets linked: ${p.imageAssets.length} (existing asset IDs)`);
  if (p.audienceSignals.length) lines.push(`Audience signals: ${p.audienceSignals.length}`);
  lines.push('');
  lines.push('All of the above is created in ONE atomic transaction (all-or-nothing) and confirmed with a SINGLE safe word.');
  lines.push('Note: this builds an asset-based PMax (no Merchant feed / listing groups). Verify before confirming; check in the Google Ads panel after.');
  return lines.join('\n');
}
