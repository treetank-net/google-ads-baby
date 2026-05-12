import os


class AdsConfig:
    def __init__(self):
        self.client_id = self._require("GOOGLE_ADS_CLIENT_ID")
        self.client_secret = self._require("GOOGLE_ADS_CLIENT_SECRET")
        self.developer_token = self._require("GOOGLE_ADS_DEVELOPER_TOKEN")
        self.refresh_token = self._require("GOOGLE_ADS_REFRESH_TOKEN")
        self.login_customer_id = self._require("GOOGLE_ADS_MCC_ID")

    @staticmethod
    def _require(key: str) -> str:
        val = os.environ.get(key)
        if not val:
            raise RuntimeError(f"Brak zmiennej środowiskowej: {key}")
        return val
