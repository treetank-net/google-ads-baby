from google.ads.googleads.client import GoogleAdsClient

from .config import AdsConfig


def get_client(cfg: AdsConfig) -> GoogleAdsClient:
    return GoogleAdsClient.load_from_dict({
        "developer_token": cfg.developer_token,
        "client_id": cfg.client_id,
        "client_secret": cfg.client_secret,
        "refresh_token": cfg.refresh_token,
        "login_customer_id": cfg.login_customer_id,
        "use_proto_plus": True,
    })


def search_stream(cfg: AdsConfig, customer_id: str, query: str) -> list[dict]:
    client = get_client(cfg)
    service = client.get_service("GoogleAdsService")
    rows = []
    response = service.search_stream(customer_id=customer_id, query=query)
    for batch in response:
        for row in batch.results:
            rows.append(_proto_to_dict(row))
    return rows


def mutate_campaign_status(
    cfg: AdsConfig, customer_id: str, campaign_id: str, status: str
) -> str:
    client = get_client(cfg)
    service = client.get_service("CampaignService")
    operation = client.get_type("CampaignOperation")
    campaign = operation.update
    campaign.resource_name = service.campaign_path(customer_id, campaign_id)
    campaign.status = client.enums.CampaignStatusEnum[status].value
    client.copy_from(
        operation.update_mask,
        client.get_type("FieldMask")(paths=["status"]),
    )
    response = service.mutate_campaigns(
        customer_id=customer_id, operations=[operation]
    )
    return response.results[0].resource_name


def mutate_campaign_budget(
    cfg: AdsConfig, customer_id: str, budget_id: str, amount_micros: int
) -> str:
    client = get_client(cfg)
    service = client.get_service("CampaignBudgetService")
    operation = client.get_type("CampaignBudgetOperation")
    budget = operation.update
    budget.resource_name = service.campaign_budget_path(customer_id, budget_id)
    budget.amount_micros = amount_micros
    client.copy_from(
        operation.update_mask,
        client.get_type("FieldMask")(paths=["amount_micros"]),
    )
    response = service.mutate_campaign_budgets(
        customer_id=customer_id, operations=[operation]
    )
    return response.results[0].resource_name


def _proto_to_dict(proto_obj) -> dict:
    try:
        return type(proto_obj).to_dict(proto_obj)
    except Exception:
        return str(proto_obj)
