import type { AdsConfig } from '../config.js';
import type { PendingMutation } from '../confirm.js';
import {
  createAdGroup,
  createAssetGroup,
  createAssetGroupAssets,
  createAssetGroupListingGroupFilters,
  createAssetGroupSignals,
  createCallAsset,
  createCalloutAssets,
  createCampaignExtensions,
  createCampaignTargeting,
  createDisplayAdGroup,
  createDisplayCampaign,
  createKeywords,
  createNegativeKeywords,
  createPerformanceMaxCampaign,
  createResponsiveDisplayAd,
  createResponsiveSearchAd,
  createSearchCampaign,
  createSitelinkAssets,
  createStructuredSnippetAssets,
  linkAdGroupAssets,
  linkCampaignAssets,
  mutateBiddingStrategy,
  mutateCampaignBudget,
  mutateCampaignStatus,
  removeCampaigns,
  uploadImageAssetFromFile,
  uploadImageAssetFromUrl,
} from '../client.js';
import { recordSuccess, recordFailure } from '../history.js';
import { MAX_IMAGE_BYTES } from './write-schemas.js';

export async function executeMutation(cfg: AdsConfig, mutation: PendingMutation, batchId?: string): Promise<string> {
  const p = mutation.params as Record<string, any>;

  const ok = (result?: unknown): string => {
    recordSuccess(mutation.action, p, mutation.preview, result, batchId);
    if (result) return `OK: ${mutation.preview} — done.\n${JSON.stringify(result, null, 2)}`;
    return `OK: ${mutation.preview} — done.`;
  };

  if (mutation.action === 'campaign_status') {
    await mutateCampaignStatus(cfg, p.customer_id, p.campaign_id, p.new_status);
    return ok();
  }

  if (mutation.action === 'campaign_removal') {
    return ok(await removeCampaigns(cfg, p.customer_id, p.campaigns.map((c: any) => c.campaign_id)));
  }

  if (mutation.action === 'budget_change') {
    await mutateCampaignBudget(cfg, p.customer_id, p.budget_id, p.amount_micros);
    return ok();
  }

  if (mutation.action === 'search_campaign_create') return ok(await createSearchCampaign(cfg, p.customer_id, p.campaign_name, p.daily_budget_micros));
  if (mutation.action === 'display_campaign_create') return ok(await createDisplayCampaign(cfg, p.customer_id, p.campaign_name, p.daily_budget_micros));

  if (mutation.action === 'performance_max_campaign_create') {
    return ok(await createPerformanceMaxCampaign(cfg, p.customer_id, p.campaign_name, p.daily_budget_micros, {
      businessNameAssetId: p.business_name_asset_id, logoAssetId: p.logo_asset_id,
    }));
  }

  if (mutation.action === 'ad_group_create') return ok(await createAdGroup(cfg, p.customer_id, p.campaign_id, p.ad_group_name, p.cpc_bid_micros));
  if (mutation.action === 'display_ad_group_create') return ok(await createDisplayAdGroup(cfg, p.customer_id, p.campaign_id, p.ad_group_name, p.cpc_bid_micros));

  if (mutation.action === 'asset_group_create') {
    return ok(await createAssetGroup(cfg, p.customer_id, p.campaign_id, p.asset_group_name, p.final_urls,
      p.assets.map((a: any) => ({ assetId: a.asset_id, fieldType: a.field_type }))));
  }

  if (mutation.action === 'responsive_search_ad_create') return ok(await createResponsiveSearchAd(cfg, p.customer_id, p.ad_group_id, p.headlines, p.descriptions, p.final_url));

  if (mutation.action === 'responsive_display_ad_create') {
    return ok(await createResponsiveDisplayAd(cfg, p.customer_id, p.ad_group_id, p.business_name, p.headlines,
      p.long_headline, p.descriptions, p.final_url, p.marketing_image_asset_ids, p.square_marketing_image_asset_ids, p.logo_image_asset_ids));
  }

  if (mutation.action === 'keywords_create') {
    return ok(await createKeywords(cfg, p.customer_id, p.ad_group_id,
      p.keywords.map((kw: any) => ({ text: kw.text, matchType: kw.match_type }))));
  }

  if (mutation.action === 'negative_keywords_create') {
    const target = p.level === 'campaign'
      ? { level: 'campaign' as const, campaignId: p.campaign_id }
      : { level: 'ad_group' as const, adGroupId: p.ad_group_id };
    return ok(await createNegativeKeywords(cfg, p.customer_id, target,
      p.keywords.map((kw: any) => ({ text: kw.text, matchType: kw.match_type }))));
  }

  if (mutation.action === 'campaign_targeting_create') {
    return ok(await createCampaignTargeting(cfg, p.customer_id, p.campaign_id,
      { locationCriterionIds: p.location_criterion_ids, languageCriterionIds: p.language_criterion_ids }));
  }

  if (mutation.action === 'campaign_assets_link') {
    return ok(await linkCampaignAssets(cfg, p.customer_id, p.campaign_id,
      p.assets.map((a: any) => ({ assetId: a.asset_id, fieldType: a.field_type }))));
  }

  if (mutation.action === 'ad_group_assets_link') {
    return ok(await linkAdGroupAssets(cfg, p.customer_id, p.ad_group_id,
      p.assets.map((a: any) => ({ assetId: a.asset_id, fieldType: a.field_type }))));
  }

  if (mutation.action === 'asset_group_assets_create') {
    return ok(await createAssetGroupAssets(cfg, p.customer_id, p.asset_group_id,
      p.assets.map((a: any) => ({ assetId: a.asset_id, fieldType: a.field_type }))));
  }

  if (mutation.action === 'asset_group_signals_create') {
    return ok(await createAssetGroupSignals(cfg, p.customer_id, p.asset_group_id,
      p.signals.map((s: any) => s.type === 'SEARCH_THEME'
        ? { type: 'SEARCH_THEME' as const, text: s.text }
        : { type: 'AUDIENCE' as const, audienceId: s.audience_id })));
  }

  if (mutation.action === 'asset_group_listing_group_filters_create') {
    return ok(await createAssetGroupListingGroupFilters(cfg, p.customer_id, p.asset_group_id,
      p.nodes.map((node: any) => {
        if (node.case_value?.kind === 'PRODUCT_BRAND') return { type: node.type, listingSource: node.listing_source, parentIndex: node.parent_index, caseValue: { product_brand: { value: node.case_value.value } } };
        if (node.case_value?.kind === 'PRODUCT_CATEGORY') return { type: node.type, listingSource: node.listing_source, parentIndex: node.parent_index, caseValue: { product_category: { category_id: node.case_value.category_id, level: node.case_value.level } } };
        if (node.case_value?.kind === 'PRODUCT_CHANNEL') return { type: node.type, listingSource: node.listing_source, parentIndex: node.parent_index, caseValue: { product_channel: { channel: node.case_value.channel } } };
        if (node.case_value?.kind === 'PRODUCT_CONDITION') return { type: node.type, listingSource: node.listing_source, parentIndex: node.parent_index, caseValue: { product_condition: { condition: node.case_value.condition } } };
        if (node.case_value?.kind === 'PRODUCT_CUSTOM_ATTRIBUTE') return { type: node.type, listingSource: node.listing_source, parentIndex: node.parent_index, caseValue: { product_custom_attribute: { index: node.case_value.index, value: node.case_value.value } } };
        if (node.case_value?.kind === 'PRODUCT_ITEM_ID') return { type: node.type, listingSource: node.listing_source, parentIndex: node.parent_index, caseValue: { product_item_id: { value: node.case_value.value } } };
        if (node.case_value?.kind === 'PRODUCT_TYPE') return { type: node.type, listingSource: node.listing_source, parentIndex: node.parent_index, caseValue: { product_type: { level: node.case_value.level, value: node.case_value.value } } };
        if (node.case_value?.kind === 'WEBPAGE') return { type: node.type, parentIndex: node.parent_index, caseValue: { webpage: { conditions: node.case_value.conditions } } };
        return { type: node.type, listingSource: node.listing_source, parentIndex: node.parent_index };
      })));
  }

  if (mutation.action === 'image_asset_upload_from_url') return ok(await uploadImageAssetFromUrl(cfg, p.customer_id, p.asset_name, p.image_url, MAX_IMAGE_BYTES));
  if (mutation.action === 'image_asset_upload_from_file') return ok(await uploadImageAssetFromFile(cfg, p.customer_id, p.asset_name, p.file_path, MAX_IMAGE_BYTES));

  if (mutation.action === 'sitelink_assets_create') {
    return ok(await createSitelinkAssets(cfg, p.customer_id,
      p.sitelinks.map((s: any) => ({ linkText: s.link_text, description1: s.description1 || '', description2: s.description2 || '', finalUrl: s.final_url }))));
  }

  if (mutation.action === 'callout_assets_create') return ok(await createCalloutAssets(cfg, p.customer_id, p.callouts));
  if (mutation.action === 'call_asset_create') return ok(await createCallAsset(cfg, p.customer_id, p.country_code, p.phone_number));
  if (mutation.action === 'structured_snippet_assets_create') return ok(await createStructuredSnippetAssets(cfg, p.customer_id, p.header, p.values));

  if (mutation.action === 'bidding_strategy_change') {
    return ok(await mutateBiddingStrategy(cfg, p.customer_id, p.campaign_id, {
      type: p.strategy_type, targetCpaMicros: p.target_cpa_micros, targetRoas: p.target_roas,
    }));
  }

  if (mutation.action === 'campaign_extensions_batch') {
    return ok(await createCampaignExtensions(cfg, p.customer_id, p.campaign_id, {
      sitelinks: p.sitelinks?.map((s: any) => ({ linkText: s.link_text, description1: s.description1 || '', description2: s.description2 || '', finalUrl: s.final_url })),
      callouts: p.callouts,
      call: p.call ? { countryCode: p.call.country_code, phoneNumber: p.call.phone_number } : undefined,
      structuredSnippet: p.structured_snippet ? { header: p.structured_snippet.header, values: p.structured_snippet.values } : undefined,
      existingAssetLinks: p.existing_asset_links?.map((a: any) => ({ assetId: a.asset_id, fieldType: a.field_type })),
    }));
  }

  return `Error: Unknown action: ${mutation.action}`;
}

export function formatMutationError(err: any): string {
  const details = err.statusDetails?.[0]?.errors;
  return details ? JSON.stringify(details) : (typeof err.message === 'string' ? err.message : JSON.stringify(err.message ?? err)) || 'Unknown Google Ads API error';
}
