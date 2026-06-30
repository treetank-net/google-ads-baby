import { z } from 'zod';

export const MAX_BUDGET_MICROS = 500_000_000; // 500 PLN safety cap
export const MAX_CPC_MICROS = 50_000_000; // 50 PLN safety cap
export const MAX_IMAGE_BYTES = 10_000_000; // 10 MB safety cap
export const MAX_KEYWORDS_PER_MUTATION = 100;
export const MAX_TARGETING_CRITERIA_PER_MUTATION = 100;
export const MAX_ASSET_GROUP_ASSETS_PER_MUTATION = 100;
export const MAX_CAMPAIGN_ASSETS_PER_MUTATION = 20;
export const MAX_ASSET_GROUP_SIGNALS_PER_MUTATION = 20;
export const MAX_ASSET_GROUP_LISTING_GROUP_NODES_PER_MUTATION = 20;
export const MAX_DEMOGRAPHIC_MODIFIERS_PER_MUTATION = 20;
export const MAX_CONVERSION_GOALS_PER_MUTATION = 50;
export const MAX_AD_SCHEDULES_PER_MUTATION = 42;
export const MAX_AD_GROUP_CRITERIA_PER_MUTATION = 100;
export const MAX_NEGATIVE_TOPICS_PER_MUTATION = 100;
export const MAX_BID_MODIFIER = 5.0;
export const CODEX_HOOK_INSTALL_COMMAND = 'npx codex-marketplace add treetank-net/google-ads-baby/hooks/google-ads-baby-safety --hook --global';
export const safeWordSchema = z.string()
  .regex(/^[A-Za-z][A-Za-z0-9_-]{2,39}$/, 'safe_word must be one short ASCII word, 3-40 chars, no spaces');
export const campaignRefSchema = z.object({
  campaign_id: z.string().describe('Campaign ID'),
  campaign_name: z.string().describe('Campaign name for preview'),
});
export const displayAssetIdListSchema = z.array(z.string()).min(1).max(15);
export const displayLogoAssetIdListSchema = z.array(z.string()).max(5);
export const cloneEntitySchema = z.enum(['ad', 'ad_group', 'campaign']);
export const keywordMatchTypeSchema = z.enum(['BROAD', 'PHRASE', 'EXACT']);
export const keywordSchema = z.object({
  text: z.string().min(1).max(80).describe('Keyword text, max 80 chars'),
  match_type: keywordMatchTypeSchema.describe('Keyword match type'),
});
export const negativeKeywordLevelSchema = z.enum(['campaign', 'ad_group']);
export const criterionIdListSchema = z.array(z.string().regex(/^\d+$/, 'Criterion IDs must be numeric')).max(MAX_TARGETING_CRITERIA_PER_MUTATION);
export const assetFieldTypeSchema = z.enum([
  'HEADLINE',
  'LONG_HEADLINE',
  'DESCRIPTION',
  'BUSINESS_NAME',
  'MARKETING_IMAGE',
  'SQUARE_MARKETING_IMAGE',
  'PORTRAIT_MARKETING_IMAGE',
  'LOGO',
  'LANDSCAPE_LOGO',
  'YOUTUBE_VIDEO',
  'CALL_TO_ACTION_SELECTION',
]);
export const campaignAssetFieldTypeSchema = z.enum([
  'HEADLINE',
  'DESCRIPTION',
  'SITELINK',
  'CALL',
  'CALLOUT',
  'STRUCTURED_SNIPPET',
  'AD_IMAGE',
  'LOGO',
  'BUSINESS_LOGO',
  'PROMOTION',
  'PRICE',
  'BUSINESS_NAME',
]);
export const campaignAssetSchema = z.object({
  asset_id: z.string().describe('Existing asset ID (from prepare_image_asset_* or execute_gaql)'),
  field_type: campaignAssetFieldTypeSchema.describe('Asset field type for campaign-level linking, e.g. AD_IMAGE for image extensions in Search'),
});
export const adGroupAssetFieldTypeSchema = z.enum([
  'HEADLINE',
  'DESCRIPTION',
  'SITELINK',
  'CALL',
  'CALLOUT',
  'STRUCTURED_SNIPPET',
  'AD_IMAGE',
  'PROMOTION',
  'PRICE',
]);
export const adGroupAssetSchema = z.object({
  asset_id: z.string().describe('Existing asset ID'),
  field_type: adGroupAssetFieldTypeSchema.describe('Asset field type for ad group-level linking'),
});
export const assetGroupSignalSchema = z.object({
  type: z.enum(['SEARCH_THEME', 'AUDIENCE']),
  text: z.string().min(1).max(50).optional().describe('Search theme text, required when type=SEARCH_THEME'),
  audience_id: z.string().regex(/^\d+$/).optional().describe('Audience ID, required when type=AUDIENCE'),
});
export const listingGroupFilterTypeSchema = z.enum(['SUBDIVISION', 'UNIT_INCLUDED', 'UNIT_EXCLUDED']);
export const listingGroupSourceSchema = z.enum(['SHOPPING', 'WEBPAGE']);
export const listingGroupCaseValueSchema = z.union([
  z.object({
    kind: z.literal('PRODUCT_BRAND'),
    value: z.string().min(1).max(60),
  }),
  z.object({
    kind: z.literal('PRODUCT_CATEGORY'),
    level: z.enum(['LEVEL1', 'LEVEL2', 'LEVEL3', 'LEVEL4', 'LEVEL5']),
    category_id: z.string().regex(/^\d+$/, 'category_id must be numeric'),
  }),
  z.object({
    kind: z.literal('PRODUCT_CHANNEL'),
    channel: z.enum(['ONLINE', 'LOCAL']),
  }),
  z.object({
    kind: z.literal('PRODUCT_CONDITION'),
    condition: z.enum(['NEW', 'REFURBISHED', 'USED']),
  }),
  z.object({
    kind: z.literal('PRODUCT_CUSTOM_ATTRIBUTE'),
    index: z.enum(['INDEX0', 'INDEX1', 'INDEX2', 'INDEX3', 'INDEX4']),
    value: z.string().min(1).max(60),
  }),
  z.object({
    kind: z.literal('PRODUCT_ITEM_ID'),
    value: z.string().min(1).max(80),
  }),
  z.object({
    kind: z.literal('PRODUCT_TYPE'),
    level: z.enum(['LEVEL1', 'LEVEL2', 'LEVEL3', 'LEVEL4', 'LEVEL5']),
    value: z.string().min(1).max(60),
  }),
  z.object({
    kind: z.literal('WEBPAGE'),
    conditions: z.array(z.string().min(1)).min(1).max(10),
  }),
]);
export const listingGroupNodeSchema = z.object({
  type: listingGroupFilterTypeSchema,
  listing_source: listingGroupSourceSchema.default('WEBPAGE'),
  parent_index: z.number().int().nonnegative().optional(),
  case_value: listingGroupCaseValueSchema.optional(),
});
export const adGroupCriterionResourceNameSchema = z.string().regex(
  /^customers\/\d+\/adGroupCriteria\/\d+~\d+$/,
  'resource_name must look like customers/{cid}/adGroupCriteria/{ag_id}~{criterion_id}',
);
export const negativeTopicSchema = z.string().regex(
  /^(topicConstants\/)?\d+$/,
  'topic must be a topic constant resource name (topicConstants/{id}) or a numeric topic ID',
);
