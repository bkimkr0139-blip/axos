"""설정 로더 — axos-bridge/.env 우선, 상위 axos/.env 폴백(N8N_API_KEY 재사용)."""
from __future__ import annotations
import os
from functools import lru_cache
from pathlib import Path
from dotenv import load_dotenv

_HERE = Path(__file__).resolve().parent.parent          # axos-bridge/
_AXOS = _HERE.parent                                    # axos/

# 1) axos-bridge/.env  2) axos/.env (override=False → 앞에서 정한 값 유지)
load_dotenv(_HERE / ".env", override=False)
load_dotenv(_AXOS / ".env", override=False)


def _b(v: str | None, default: bool = False) -> bool:
    if v is None:
        return default
    return v.strip().lower() in ("1", "true", "yes", "on")


class Settings:
    def __init__(self) -> None:
        # AXOS Bridge
        self.env = os.getenv("AXOS_ENV", "local")
        self.api_key = os.getenv("AXOS_API_KEY", "")
        self.allowed_origins = [o.strip() for o in os.getenv(
            "AXOS_ALLOWED_ORIGINS",
            "http://localhost:5173,https://*.base44.app",
        ).split(",") if o.strip()]
        self.port = int(os.getenv("BRIDGE_PORT", "8000"))
        self.log_level = os.getenv("LOG_LEVEL", "INFO")

        # Databricks
        self.dbx_host = os.getenv("DATABRICKS_HOST", "").rstrip("/")
        self.dbx_token = os.getenv("DATABRICKS_TOKEN", "")
        self.dbx_catalog = os.getenv("DATABRICKS_CATALOG", "axos_catalog")
        self.dbx_schema = os.getenv("DATABRICKS_SCHEMA", "gold")
        self.dbx_warehouse_id = os.getenv("DATABRICKS_SQL_WAREHOUSE_ID", "")
        self.dbx_model_endpoint = os.getenv("DATABRICKS_MODEL_ENDPOINT", "")
        self.dbx_vector_endpoint = os.getenv("DATABRICKS_VECTOR_ENDPOINT", "")
        self.dbx_vector_index = os.getenv("DATABRICKS_VECTOR_INDEX", "")
        self.dbx_mcp_url = os.getenv("DATABRICKS_MCP_SERVER_URL", "")
        self.dbx_mcp_token = os.getenv("DATABRICKS_MCP_AUTH_TOKEN", "")
        self.dbx_allow_write = _b(os.getenv("DATABRICKS_ALLOW_WRITE"), False)

        # MX-Flow (n8n) — MXFLOW_API_KEY 없으면 상위 .env 의 N8N_API_KEY 재사용
        self.mxflow_base = os.getenv("MXFLOW_BASE_URL", "http://localhost:5678").rstrip("/")
        self.mxflow_api_key = os.getenv("MXFLOW_API_KEY") or os.getenv("N8N_API_KEY", "")
        self.mxflow_webhook_base = os.getenv(
            "MXFLOW_WEBHOOK_BASE_URL", self.mxflow_base + "/webhook").rstrip("/")
        self.mxflow_webhook_secret = (
            os.getenv("MXFLOW_WEBHOOK_SECRET")
            or os.getenv("N8N_WEBHOOK_TOKEN", "dev-local-token"))

        # Storage
        self.audit_db_url = os.getenv("AUDIT_DB_URL", "sqlite:///./axos_audit.db")

    @property
    def databricks_configured(self) -> bool:
        return bool(self.dbx_host and self.dbx_token)

    @property
    def mxflow_api_configured(self) -> bool:
        return bool(self.mxflow_base and self.mxflow_api_key)


@lru_cache
def get_settings() -> "Settings":
    return Settings()
