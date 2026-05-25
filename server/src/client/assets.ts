import { enums, ResourceNames } from 'google-ads-api';
import { readFileSync, statSync } from 'fs';
import { getCustomer } from './core.js';
import type { AdsConfig } from '../config.js';

export async function createAssetGroup(
  cfg: AdsConfig,
  customerId: string,
  campaignId: string,
  name: string,
  finalUrls: string[],
  assets: Array<{ assetId: string; fieldType: string }>,
): Promise<unknown> {
  const customer = getCustomer(cfg, customerId);
  const assetGroupResourceName = ResourceNames.assetGroup(customerId, '-1');
  return customer.mutateResources([
    {
      entity: 'asset_group',
      operation: 'create',
      resource: {
        resource_name: assetGroupResourceName,
        campaign: ResourceNames.campaign(customerId, campaignId),
        name,
        final_urls: finalUrls,
        status: enums.AssetGroupStatus.PAUSED,
      },
    },
    ...assets.map((asset) => ({
      entity: 'asset_group_asset',
      operation: 'create',
      resource: {
        asset_group: assetGroupResourceName,
        asset: ResourceNames.asset(customerId, asset.assetId),
        field_type: (enums.AssetFieldType as any)[asset.fieldType],
      },
    })),
  ] as any);
}

export async function createAssetGroupAssets(
  cfg: AdsConfig,
  customerId: string,
  assetGroupId: string,
  assets: Array<{ assetId: string; fieldType: string }>,
): Promise<unknown> {
  const customer = getCustomer(cfg, customerId);
  return customer.assetGroupAssets.create(assets.map((asset) => ({
    asset_group: ResourceNames.assetGroup(customerId, assetGroupId),
    asset: ResourceNames.asset(customerId, asset.assetId),
    field_type: (enums.AssetFieldType as any)[asset.fieldType],
  }) as any));
}

export async function createAssetGroupSignals(
  cfg: AdsConfig,
  customerId: string,
  assetGroupId: string,
  signals: Array<
    | { type: 'SEARCH_THEME'; text: string }
    | { type: 'AUDIENCE'; audienceId: string }
  >,
): Promise<unknown> {
  const customer = getCustomer(cfg, customerId);
  return customer.assetGroupSignals.create(signals.map((signal) => {
    if (signal.type === 'SEARCH_THEME') {
      return {
        asset_group: ResourceNames.assetGroup(customerId, assetGroupId),
        search_theme: { text: signal.text },
      } as any;
    }
    return {
      asset_group: ResourceNames.assetGroup(customerId, assetGroupId),
      audience: {
        audience: ResourceNames.audience(customerId, signal.audienceId),
      },
    } as any;
  }));
}

export async function createAssetGroupListingGroupFilters(
  cfg: AdsConfig,
  customerId: string,
  assetGroupId: string,
  nodes: Array<{
    type: 'SUBDIVISION' | 'UNIT_INCLUDED' | 'UNIT_EXCLUDED';
    listingSource: 'SHOPPING' | 'WEBPAGE';
    parentIndex?: number;
    caseValue?: Record<string, unknown>;
  }>,
): Promise<unknown> {
  const customer = getCustomer(cfg, customerId);
  const tempResourceNames = nodes.map((_, index) => ResourceNames.assetGroupListingGroupFilter(customerId, assetGroupId, `-${index + 1}`));
  return customer.mutateResources(nodes.map((node, index) => ({
    entity: 'asset_group_listing_group_filter',
    operation: 'create',
      resource: {
      resource_name: tempResourceNames[index],
      asset_group: ResourceNames.assetGroup(customerId, assetGroupId),
      listing_source: (enums.ListingGroupFilterListingSource as any)[node.listingSource],
      type: (enums.ListingGroupFilterType as any)[node.type],
      ...(node.parentIndex === undefined ? {} : {
        parent_listing_group_filter: tempResourceNames[node.parentIndex],
      }),
      ...(node.caseValue ? { case_value: node.caseValue } : {}),
    },
  })) as any);
}

export interface CampaignExtensionsInput {
  sitelinks?: Array<{ linkText: string; description1: string; description2: string; finalUrl: string }>;
  callouts?: string[];
  call?: { countryCode: string; phoneNumber: string };
  structuredSnippet?: { header: string; values: string[] };
  existingAssetLinks?: Array<{ assetId: string; fieldType: string }>;
}

export async function createCampaignExtensions(
  cfg: AdsConfig,
  customerId: string,
  campaignId: string,
  input: CampaignExtensionsInput,
): Promise<unknown> {
  const customer = getCustomer(cfg, customerId);
  const ops: any[] = [];
  let tempId = -1;
  const campaignResource = ResourceNames.campaign(customerId, campaignId);

  for (const s of input.sitelinks ?? []) {
    const assetResource = ResourceNames.asset(customerId, String(tempId));
    ops.push({
      entity: 'asset',
      operation: 'create',
      resource: {
        resource_name: assetResource,
        name: s.linkText,
        type: enums.AssetType.SITELINK,
        sitelink_asset: { link_text: s.linkText, description1: s.description1, description2: s.description2, final_urls: [s.finalUrl] },
      },
    });
    ops.push({
      entity: 'campaign_asset',
      operation: 'create',
      resource: { campaign: campaignResource, asset: assetResource, field_type: enums.AssetFieldType.SITELINK },
    });
    tempId--;
  }

  for (const text of input.callouts ?? []) {
    const assetResource = ResourceNames.asset(customerId, String(tempId));
    ops.push({
      entity: 'asset',
      operation: 'create',
      resource: { resource_name: assetResource, name: text, type: enums.AssetType.CALLOUT, callout_asset: { callout_text: text } },
    });
    ops.push({
      entity: 'campaign_asset',
      operation: 'create',
      resource: { campaign: campaignResource, asset: assetResource, field_type: enums.AssetFieldType.CALLOUT },
    });
    tempId--;
  }

  if (input.call) {
    const assetResource = ResourceNames.asset(customerId, String(tempId));
    ops.push({
      entity: 'asset',
      operation: 'create',
      resource: {
        resource_name: assetResource,
        name: `${input.call.countryCode} ${input.call.phoneNumber}`,
        type: enums.AssetType.CALL,
        call_asset: { country_code: input.call.countryCode, phone_number: input.call.phoneNumber },
      },
    });
    ops.push({
      entity: 'campaign_asset',
      operation: 'create',
      resource: { campaign: campaignResource, asset: assetResource, field_type: enums.AssetFieldType.CALL },
    });
    tempId--;
  }

  if (input.structuredSnippet) {
    const assetResource = ResourceNames.asset(customerId, String(tempId));
    ops.push({
      entity: 'asset',
      operation: 'create',
      resource: {
        resource_name: assetResource,
        name: `${input.structuredSnippet.header}: ${input.structuredSnippet.values.join(', ')}`,
        type: enums.AssetType.STRUCTURED_SNIPPET,
        structured_snippet_asset: { header: input.structuredSnippet.header, values: input.structuredSnippet.values },
      },
    });
    ops.push({
      entity: 'campaign_asset',
      operation: 'create',
      resource: { campaign: campaignResource, asset: assetResource, field_type: enums.AssetFieldType.STRUCTURED_SNIPPET },
    });
    tempId--;
  }

  for (const link of input.existingAssetLinks ?? []) {
    ops.push({
      entity: 'campaign_asset',
      operation: 'create',
      resource: {
        campaign: campaignResource,
        asset: ResourceNames.asset(customerId, link.assetId),
        field_type: (enums.AssetFieldType as any)[link.fieldType],
      },
    });
  }

  return customer.mutateResources(ops);
}

export async function createSitelinkAssets(
  cfg: AdsConfig,
  customerId: string,
  sitelinks: Array<{ linkText: string; description1: string; description2: string; finalUrl: string }>,
): Promise<unknown> {
  const customer = getCustomer(cfg, customerId);
  return customer.assets.create(sitelinks.map((s) => ({
    name: s.linkText,
    type: enums.AssetType.SITELINK,
    sitelink_asset: {
      link_text: s.linkText,
      description1: s.description1,
      description2: s.description2,
      final_urls: [s.finalUrl],
    },
  })) as any);
}

export async function createCalloutAssets(
  cfg: AdsConfig,
  customerId: string,
  callouts: string[],
): Promise<unknown> {
  const customer = getCustomer(cfg, customerId);
  return customer.assets.create(callouts.map((text) => ({
    name: text,
    type: enums.AssetType.CALLOUT,
    callout_asset: {
      callout_text: text,
    },
  })) as any);
}

export async function createCallAsset(
  cfg: AdsConfig,
  customerId: string,
  countryCode: string,
  phoneNumber: string,
): Promise<unknown> {
  const customer = getCustomer(cfg, customerId);
  return customer.assets.create([{
    name: `${countryCode} ${phoneNumber}`,
    type: enums.AssetType.CALL,
    call_asset: {
      country_code: countryCode,
      phone_number: phoneNumber,
    },
  }] as any);
}

export async function createStructuredSnippetAssets(
  cfg: AdsConfig,
  customerId: string,
  header: string,
  values: string[],
): Promise<unknown> {
  const customer = getCustomer(cfg, customerId);
  return customer.assets.create([{
    name: `${header}: ${values.join(', ')}`,
    type: enums.AssetType.STRUCTURED_SNIPPET,
    structured_snippet_asset: {
      header,
      values,
    },
  }] as any);
}

export async function linkCampaignAssets(
  cfg: AdsConfig,
  customerId: string,
  campaignId: string,
  assets: Array<{ assetId: string; fieldType: string }>,
): Promise<unknown> {
  const customer = getCustomer(cfg, customerId);
  return customer.mutateResources(assets.map((asset) => ({
    entity: 'campaign_asset',
    operation: 'create',
    resource: {
      campaign: ResourceNames.campaign(customerId, campaignId),
      asset: ResourceNames.asset(customerId, asset.assetId),
      field_type: (enums.AssetFieldType as any)[asset.fieldType],
    },
  })) as any);
}

export async function linkAdGroupAssets(
  cfg: AdsConfig,
  customerId: string,
  adGroupId: string,
  assets: Array<{ assetId: string; fieldType: string }>,
): Promise<unknown> {
  const customer = getCustomer(cfg, customerId);
  return customer.mutateResources(assets.map((asset) => ({
    entity: 'ad_group_asset',
    operation: 'create',
    resource: {
      ad_group: ResourceNames.adGroup(customerId, adGroupId),
      asset: ResourceNames.asset(customerId, asset.assetId),
      field_type: (enums.AssetFieldType as any)[asset.fieldType],
    },
  })) as any);
}

export async function uploadImageAssetFromUrl(
  cfg: AdsConfig,
  customerId: string,
  assetName: string,
  imageUrl: string,
  maxImageBytes: number,
): Promise<unknown> {
  const customer = getCustomer(cfg, customerId);
  const response = await fetch(imageUrl);
  if (!response.ok) {
    throw new Error(`Image download failed: HTTP ${response.status} from ${imageUrl}`);
  }

  const contentLength = Number(response.headers.get('content-length') || '');
  if (Number.isFinite(contentLength) && contentLength > maxImageBytes) {
    throw new Error(`Image is too large (${contentLength} bytes). Max allowed: ${maxImageBytes} bytes.`);
  }

  const contentType = response.headers.get('content-type') || '';
  if (!contentType.toLowerCase().startsWith('image/')) {
    throw new Error(`URL does not look like an image (content-type: ${contentType || 'unknown'}).`);
  }

  const data = Buffer.from(await response.arrayBuffer());
  if (!data.length) {
    throw new Error('Downloaded image is empty.');
  }
  if (data.length > maxImageBytes) {
    throw new Error(`Image is too large (${data.length} bytes). Max allowed: ${maxImageBytes} bytes.`);
  }

  return customer.assets.create([
    {
      name: assetName,
      image_asset: { data },
    } as any,
  ]);
}

export async function uploadImageAssetFromFile(
  cfg: AdsConfig,
  customerId: string,
  assetName: string,
  filePath: string,
  maxImageBytes: number,
): Promise<unknown> {
  const customer = getCustomer(cfg, customerId);
  const st = statSync(filePath);
  if (!st.isFile()) {
    throw new Error(`Path is not a file: ${filePath}`);
  }
  if (st.size <= 0) {
    throw new Error(`File is empty: ${filePath}`);
  }
  if (st.size > maxImageBytes) {
    throw new Error(`File is too large (${st.size} bytes). Max allowed: ${maxImageBytes} bytes.`);
  }

  const data = readFileSync(filePath);
  if (!data.length) {
    throw new Error(`File is empty: ${filePath}`);
  }

  return customer.assets.create([
    {
      name: assetName,
      image_asset: { data },
    } as any,
  ]);
}
