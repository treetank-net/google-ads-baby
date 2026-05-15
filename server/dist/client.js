import { GoogleAdsApi, enums, ResourceNames } from 'google-ads-api';
import { readFileSync, statSync } from 'fs';
function getCustomer(cfg, customerId) {
    const api = new GoogleAdsApi({
        client_id: cfg.clientId,
        client_secret: cfg.clientSecret,
        developer_token: cfg.developerToken,
    });
    return api.Customer({
        customer_id: customerId,
        login_customer_id: cfg.loginCustomerId,
        refresh_token: cfg.refreshToken,
    });
}
export async function listAccounts(cfg) {
    const customer = getCustomer(cfg, cfg.loginCustomerId);
    const rows = await customer.query(`
    SELECT customer_client.id, customer_client.descriptive_name,
           customer_client.currency_code, customer_client.manager,
           customer_client.status
    FROM customer_client
    WHERE customer_client.status = 'ENABLED'
      AND customer_client.manager = false
    ORDER BY customer_client.descriptive_name
  `);
    return rows.map((r) => ({
        id: String(r.customer_client?.id),
        name: r.customer_client?.descriptive_name,
        currency: r.customer_client?.currency_code,
    }));
}
export async function getCampaigns(cfg, customerId, days = 30) {
    const customer = getCustomer(cfg, customerId);
    return customer.query(`
    SELECT campaign.id, campaign.name, campaign.status,
           campaign.advertising_channel_type,
           metrics.impressions, metrics.clicks, metrics.ctr,
           metrics.cost_micros, metrics.conversions,
           metrics.conversions_value
    FROM campaign
    WHERE segments.date DURING LAST_${days}_DAYS
      AND metrics.impressions > 0
    ORDER BY metrics.cost_micros DESC
  `);
}
export async function executeGaql(cfg, customerId, query) {
    const customer = getCustomer(cfg, customerId);
    return customer.query(query);
}
export async function mutateCampaignStatus(cfg, customerId, campaignId, status) {
    return mutateCampaignStatuses(cfg, customerId, [{ campaignId, status }]);
}
export async function mutateCampaignStatuses(cfg, customerId, campaigns) {
    const customer = getCustomer(cfg, customerId);
    return customer.campaigns.update(campaigns.map(({ campaignId, status }) => ({
        resource_name: `customers/${customerId}/campaigns/${campaignId}`,
        status: enums.CampaignStatus[status],
    })));
}
export async function removeCampaigns(cfg, customerId, campaignIds) {
    const customer = getCustomer(cfg, customerId);
    return customer.campaigns.remove(campaignIds.map((campaignId) => (`customers/${customerId}/campaigns/${campaignId}`)));
}
export async function mutateCampaignBudget(cfg, customerId, budgetId, amountMicros) {
    const customer = getCustomer(cfg, customerId);
    return customer.campaignBudgets.update([
        {
            resource_name: `customers/${customerId}/campaignBudgets/${budgetId}`,
            amount_micros: amountMicros,
        },
    ]);
}
export async function createSearchCampaign(cfg, customerId, name, dailyBudgetMicros) {
    const customer = getCustomer(cfg, customerId);
    const budgetResourceName = ResourceNames.campaignBudget(customerId, '-1');
    return customer.mutateResources([
        {
            entity: 'campaign_budget',
            operation: 'create',
            resource: {
                resource_name: budgetResourceName,
                name: `${name} Budget`,
                delivery_method: enums.BudgetDeliveryMethod.STANDARD,
                explicitly_shared: false,
                amount_micros: dailyBudgetMicros,
            },
        },
        {
            entity: 'campaign',
            operation: 'create',
            resource: {
                name,
                advertising_channel_type: enums.AdvertisingChannelType.SEARCH,
                status: enums.CampaignStatus.PAUSED,
                manual_cpc: { enhanced_cpc_enabled: false },
                campaign_budget: budgetResourceName,
                contains_eu_political_advertising: enums.EuPoliticalAdvertisingStatus.DOES_NOT_CONTAIN_EU_POLITICAL_ADVERTISING,
                network_settings: {
                    target_google_search: true,
                    target_search_network: true,
                    target_content_network: false,
                    target_partner_search_network: false,
                },
            },
        },
    ]);
}
export async function createDisplayCampaign(cfg, customerId, name, dailyBudgetMicros) {
    const customer = getCustomer(cfg, customerId);
    const budgetResourceName = ResourceNames.campaignBudget(customerId, '-1');
    return customer.mutateResources([
        {
            entity: 'campaign_budget',
            operation: 'create',
            resource: {
                resource_name: budgetResourceName,
                name: `${name} Budget`,
                delivery_method: enums.BudgetDeliveryMethod.STANDARD,
                explicitly_shared: false,
                amount_micros: dailyBudgetMicros,
            },
        },
        {
            entity: 'campaign',
            operation: 'create',
            resource: {
                name,
                advertising_channel_type: enums.AdvertisingChannelType.DISPLAY,
                status: enums.CampaignStatus.PAUSED,
                manual_cpc: { enhanced_cpc_enabled: false },
                campaign_budget: budgetResourceName,
                contains_eu_political_advertising: enums.EuPoliticalAdvertisingStatus.DOES_NOT_CONTAIN_EU_POLITICAL_ADVERTISING,
            },
        },
    ]);
}
export async function createPerformanceMaxCampaign(cfg, customerId, name, dailyBudgetMicros, brandAssets) {
    const customer = getCustomer(cfg, customerId);
    const budgetResourceName = ResourceNames.campaignBudget(customerId, '-1');
    const campaignResourceName = ResourceNames.campaign(customerId, '-2');
    return customer.mutateResources([
        {
            entity: 'campaign_budget',
            operation: 'create',
            resource: {
                resource_name: budgetResourceName,
                name: `${name} Budget`,
                delivery_method: enums.BudgetDeliveryMethod.STANDARD,
                explicitly_shared: false,
                amount_micros: dailyBudgetMicros,
            },
        },
        {
            entity: 'campaign',
            operation: 'create',
            resource: {
                resource_name: campaignResourceName,
                name,
                advertising_channel_type: enums.AdvertisingChannelType.PERFORMANCE_MAX,
                status: enums.CampaignStatus.PAUSED,
                campaign_budget: budgetResourceName,
                maximize_conversion_value: {},
                contains_eu_political_advertising: enums.EuPoliticalAdvertisingStatus.DOES_NOT_CONTAIN_EU_POLITICAL_ADVERTISING,
            },
        },
        ...(brandAssets?.businessNameAssetId ? [{
                entity: 'campaign_asset',
                operation: 'create',
                resource: {
                    campaign: campaignResourceName,
                    asset: ResourceNames.asset(customerId, brandAssets.businessNameAssetId),
                    field_type: enums.AssetFieldType.BUSINESS_NAME,
                },
            }] : []),
        ...(brandAssets?.logoAssetId ? [{
                entity: 'campaign_asset',
                operation: 'create',
                resource: {
                    campaign: campaignResourceName,
                    asset: ResourceNames.asset(customerId, brandAssets.logoAssetId),
                    field_type: enums.AssetFieldType.LOGO,
                },
            }] : []),
    ]);
}
export async function createAdGroup(cfg, customerId, campaignId, name, cpcBidMicros) {
    const customer = getCustomer(cfg, customerId);
    return customer.adGroups.create([
        {
            name,
            campaign: ResourceNames.campaign(customerId, campaignId),
            status: enums.AdGroupStatus.PAUSED,
            type: enums.AdGroupType.SEARCH_STANDARD,
            cpc_bid_micros: cpcBidMicros,
        },
    ]);
}
export async function createDisplayAdGroup(cfg, customerId, campaignId, name, cpcBidMicros) {
    const customer = getCustomer(cfg, customerId);
    return customer.adGroups.create([
        {
            name,
            campaign: ResourceNames.campaign(customerId, campaignId),
            status: enums.AdGroupStatus.PAUSED,
            type: enums.AdGroupType.DISPLAY_STANDARD,
            cpc_bid_micros: cpcBidMicros,
        },
    ]);
}
export async function createResponsiveSearchAd(cfg, customerId, adGroupId, headlines, descriptions, finalUrl) {
    const customer = getCustomer(cfg, customerId);
    return customer.adGroupAds.create([
        {
            ad_group: ResourceNames.adGroup(customerId, adGroupId),
            status: enums.AdGroupAdStatus.PAUSED,
            ad: {
                type: enums.AdType.RESPONSIVE_SEARCH_AD,
                final_urls: [finalUrl],
                responsive_search_ad: {
                    headlines: headlines.map((text) => ({ text })),
                    descriptions: descriptions.map((text) => ({ text })),
                },
            },
        },
    ]);
}
export async function createKeywords(cfg, customerId, adGroupId, keywords) {
    const customer = getCustomer(cfg, customerId);
    return customer.adGroupCriteria.create(keywords.map((keyword) => ({
        ad_group: ResourceNames.adGroup(customerId, adGroupId),
        status: enums.AdGroupCriterionStatus.ENABLED,
        keyword: {
            text: keyword.text,
            match_type: enums.KeywordMatchType[keyword.matchType],
        },
    })));
}
export async function createNegativeKeywords(cfg, customerId, target, keywords) {
    const customer = getCustomer(cfg, customerId);
    if (target.level === 'campaign') {
        return customer.campaignCriteria.create(keywords.map((keyword) => ({
            campaign: ResourceNames.campaign(customerId, target.campaignId),
            negative: true,
            keyword: {
                text: keyword.text,
                match_type: enums.KeywordMatchType[keyword.matchType],
            },
        })));
    }
    return customer.adGroupCriteria.create(keywords.map((keyword) => ({
        ad_group: ResourceNames.adGroup(customerId, target.adGroupId),
        negative: true,
        keyword: {
            text: keyword.text,
            match_type: enums.KeywordMatchType[keyword.matchType],
        },
    })));
}
export async function createCampaignTargeting(cfg, customerId, campaignId, targeting) {
    const customer = getCustomer(cfg, customerId);
    return customer.campaignCriteria.create([
        ...targeting.locationCriterionIds.map((criterionId) => ({
            campaign: ResourceNames.campaign(customerId, campaignId),
            location: {
                geo_target_constant: ResourceNames.geoTargetConstant(criterionId),
            },
        })),
        ...targeting.languageCriterionIds.map((criterionId) => ({
            campaign: ResourceNames.campaign(customerId, campaignId),
            language: {
                language_constant: ResourceNames.languageConstant(criterionId),
            },
        })),
    ]);
}
export async function createAssetGroup(cfg, customerId, campaignId, name, finalUrls, assets) {
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
                field_type: enums.AssetFieldType[asset.fieldType],
            },
        })),
    ]);
}
export async function createAssetGroupAssets(cfg, customerId, assetGroupId, assets) {
    const customer = getCustomer(cfg, customerId);
    return customer.assetGroupAssets.create(assets.map((asset) => ({
        asset_group: ResourceNames.assetGroup(customerId, assetGroupId),
        asset: ResourceNames.asset(customerId, asset.assetId),
        field_type: enums.AssetFieldType[asset.fieldType],
    })));
}
export async function createAssetGroupSignals(cfg, customerId, assetGroupId, signals) {
    const customer = getCustomer(cfg, customerId);
    return customer.assetGroupSignals.create(signals.map((signal) => {
        if (signal.type === 'SEARCH_THEME') {
            return {
                asset_group: ResourceNames.assetGroup(customerId, assetGroupId),
                search_theme: { text: signal.text },
            };
        }
        return {
            asset_group: ResourceNames.assetGroup(customerId, assetGroupId),
            audience: {
                audience: ResourceNames.audience(customerId, signal.audienceId),
            },
        };
    }));
}
export async function createResponsiveDisplayAd(cfg, customerId, adGroupId, businessName, headlines, longHeadline, descriptions, finalUrl, marketingImageAssetIds, squareMarketingImageAssetIds, logoImageAssetIds) {
    const customer = getCustomer(cfg, customerId);
    return customer.adGroupAds.create([
        {
            ad_group: ResourceNames.adGroup(customerId, adGroupId),
            status: enums.AdGroupAdStatus.PAUSED,
            ad: {
                type: enums.AdType.RESPONSIVE_DISPLAY_AD,
                final_urls: [finalUrl],
                responsive_display_ad: {
                    business_name: businessName,
                    headlines: headlines.map((text) => ({ text })),
                    long_headline: { text: longHeadline },
                    descriptions: descriptions.map((text) => ({ text })),
                    marketing_images: marketingImageAssetIds.map((assetId) => ({
                        asset: ResourceNames.asset(customerId, assetId),
                    })),
                    square_marketing_images: squareMarketingImageAssetIds.map((assetId) => ({
                        asset: ResourceNames.asset(customerId, assetId),
                    })),
                    logo_images: logoImageAssetIds.map((assetId) => ({
                        asset: ResourceNames.asset(customerId, assetId),
                    })),
                },
            },
        },
    ]);
}
export async function uploadImageAssetFromUrl(cfg, customerId, assetName, imageUrl, maxImageBytes) {
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
        },
    ]);
}
export async function uploadImageAssetFromFile(cfg, customerId, assetName, filePath, maxImageBytes) {
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
        },
    ]);
}
//# sourceMappingURL=client.js.map