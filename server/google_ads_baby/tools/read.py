import json
import re

from fastmcp import FastMCP
from mcp.types import ToolAnnotations

from ..client import search_stream
from ..config import AdsConfig


def register(mcp: FastMCP, cfg: AdsConfig):
    @mcp.tool(annotations=ToolAnnotations(readOnlyHint=True))
    def list_accounts() -> str:
        """List all Google Ads accounts under the MCC."""
        rows = search_stream(
            cfg,
            cfg.login_customer_id,
            """
            SELECT customer_client.id, customer_client.descriptive_name,
                   customer_client.currency_code, customer_client.manager,
                   customer_client.status
            FROM customer_client
            WHERE customer_client.status = 'ENABLED'
              AND customer_client.manager = false
            ORDER BY customer_client.descriptive_name
            """,
        )
        accounts = [
            {
                "id": str(r.get("customer_client", {}).get("id", "")),
                "name": r.get("customer_client", {}).get("descriptive_name", ""),
                "currency": r.get("customer_client", {}).get("currency_code", ""),
            }
            for r in rows
        ]
        return json.dumps(accounts, indent=2, ensure_ascii=False)

    @mcp.tool(annotations=ToolAnnotations(readOnlyHint=True))
    def get_campaigns(customer_id: str, days: int = 30) -> str:
        """Get campaigns with performance metrics for a specific account.

        Args:
            customer_id: Google Ads customer ID (e.g. "1234567890")
            days: Lookback period — 7 or 30
        """
        period = "LAST_7_DAYS" if days == 7 else "LAST_30_DAYS"
        rows = search_stream(
            cfg,
            customer_id,
            f"""
            SELECT campaign.id, campaign.name, campaign.status,
                   campaign.advertising_channel_type,
                   metrics.impressions, metrics.clicks, metrics.ctr,
                   metrics.cost_micros, metrics.conversions,
                   metrics.conversions_value
            FROM campaign
            WHERE segments.date DURING {period}
              AND metrics.impressions > 0
            ORDER BY metrics.cost_micros DESC
            """,
        )
        return json.dumps(rows, indent=2, ensure_ascii=False)

    @mcp.tool(annotations=ToolAnnotations(readOnlyHint=True))
    def execute_gaql(customer_id: str, query: str) -> str:
        """Run an arbitrary GAQL query against a Google Ads account (read-only).

        Args:
            customer_id: Google Ads customer ID
            query: GAQL query (SELECT ... FROM ... WHERE ...)
        """
        if re.search(r"\b(CREATE|UPDATE|REMOVE|MUTATE)\b", query, re.IGNORECASE):
            return "Error: GAQL mutations not allowed via this tool. Use prepare_* tools instead."
        rows = search_stream(cfg, customer_id, query)
        return json.dumps(rows, indent=2, ensure_ascii=False)
