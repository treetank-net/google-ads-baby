import json

from fastmcp import FastMCP
from mcp.types import ToolAnnotations

from ..client import mutate_campaign_budget, mutate_campaign_status
from ..config import AdsConfig
from ..confirm import consume_token, create_token, list_pending

MAX_BUDGET_MICROS = 500_000_000  # 500 PLN safety cap


def register(mcp: FastMCP, cfg: AdsConfig):
    @mcp.tool(annotations=ToolAnnotations(destructiveHint=True))
    def prepare_campaign_status(
        customer_id: str,
        campaign_id: str,
        campaign_name: str,
        new_status: str,
    ) -> str:
        """Prepare a campaign status change (enable/pause). Returns a preview and confirmation token.

        Args:
            customer_id: Google Ads customer ID
            campaign_id: Campaign ID
            campaign_name: Campaign name (for preview)
            new_status: ENABLED or PAUSED
        """
        if new_status not in ("ENABLED", "PAUSED"):
            return "Error: new_status must be ENABLED or PAUSED"

        action = "Włączenie" if new_status == "ENABLED" else "Wstrzymanie"
        preview = f'{action} kampanii "{campaign_name}" (ID: {campaign_id}) na koncie {customer_id}'
        mutation = create_token(
            "campaign_status",
            {"customer_id": customer_id, "campaign_id": campaign_id, "new_status": new_status},
            preview,
        )
        return json.dumps(
            {
                "preview": preview,
                "token": mutation["token"],
                "expires_in_seconds": 60,
                "instruction": "Pokaż użytkownikowi preview i poczekaj na jego odpowiedź. Dopiero potem wywołaj confirm_mutation z tokenem.",
            },
            indent=2,
            ensure_ascii=False,
        )

    @mcp.tool(annotations=ToolAnnotations(destructiveHint=True))
    def prepare_budget_change(
        customer_id: str,
        budget_id: str,
        campaign_name: str,
        current_budget_pln: float,
        new_budget_pln: float,
    ) -> str:
        """Prepare a campaign budget change. Returns a preview and confirmation token.

        Args:
            customer_id: Google Ads customer ID
            budget_id: Campaign budget resource ID
            campaign_name: Campaign name (for preview)
            current_budget_pln: Current daily budget in PLN
            new_budget_pln: New daily budget in PLN
        """
        new_micros = round(new_budget_pln * 1_000_000)
        if new_micros > MAX_BUDGET_MICROS:
            return (
                f"Error: Budżet {new_budget_pln} PLN przekracza limit bezpieczeństwa "
                f"({MAX_BUDGET_MICROS / 1_000_000:.0f} PLN/dzień)."
            )

        preview = (
            f'Zmiana budżetu kampanii "{campaign_name}": '
            f"{current_budget_pln} → {new_budget_pln} PLN/dzień (konto {customer_id})"
        )
        mutation = create_token(
            "budget_change",
            {"customer_id": customer_id, "budget_id": budget_id, "amount_micros": new_micros},
            preview,
        )
        return json.dumps(
            {
                "preview": preview,
                "token": mutation["token"],
                "expires_in_seconds": 60,
                "instruction": "Pokaż użytkownikowi preview i poczekaj na jego odpowiedź. Dopiero potem wywołaj confirm_mutation z tokenem.",
            },
            indent=2,
            ensure_ascii=False,
        )

    @mcp.tool(annotations=ToolAnnotations(destructiveHint=True))
    def confirm_mutation(token: str) -> str:
        """Execute a previously prepared mutation. Requires a valid, non-expired token.

        Args:
            token: Confirmation token from prepare_* response
        """
        mutation = consume_token(token)
        if not mutation:
            return "Error: Token nieważny lub wygasł. Przygotuj operację ponownie za pomocą prepare_*."

        try:
            p = mutation["params"]

            if mutation["action"] == "campaign_status":
                mutate_campaign_status(cfg, p["customer_id"], p["campaign_id"], p["new_status"])
                return f'OK: {mutation["preview"]} — wykonano.'

            if mutation["action"] == "budget_change":
                mutate_campaign_budget(cfg, p["customer_id"], p["budget_id"], p["amount_micros"])
                return f'OK: {mutation["preview"]} — wykonano.'

            return f'Error: Nieznana akcja: {mutation["action"]}'
        except Exception as e:
            return f"Error: {e}"

    @mcp.tool(annotations=ToolAnnotations(readOnlyHint=True))
    def list_pending_mutations() -> str:
        """List all pending (unconfirmed) mutations with their previews and tokens."""
        items = list_pending()
        if not items:
            return "Brak oczekujących operacji."
        return json.dumps(items, indent=2, ensure_ascii=False, default=str)
