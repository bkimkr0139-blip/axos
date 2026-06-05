"""Databricks REST API client (Unity Catalog, Model Serving 등). 미설정 시 graceful."""
from __future__ import annotations
from typing import Any
import httpx
from ...config import get_settings


class DatabricksRestClient:
    def __init__(self) -> None:
        s = get_settings()
        self.host = s.dbx_host
        self.token = s.dbx_token
        self.timeout = 15.0

    @property
    def configured(self) -> bool:
        return bool(self.host and self.token)

    def _headers(self) -> dict[str, str]:
        return {"Authorization": f"Bearer {self.token}", "Accept": "application/json"}

    async def get(self, path: str, params: dict[str, Any] | None = None) -> dict[str, Any]:
        if not self.configured:
            return {"_unconfigured": True}
        async with httpx.AsyncClient(timeout=self.timeout) as c:
            r = await c.get(self.host + path, headers=self._headers(), params=params)
            r.raise_for_status()
            return r.json()

    async def post(self, path: str, body: dict[str, Any]) -> dict[str, Any]:
        if not self.configured:
            return {"_unconfigured": True}
        async with httpx.AsyncClient(timeout=self.timeout) as c:
            r = await c.post(self.host + path, headers=self._headers(), json=body)
            r.raise_for_status()
            return r.json()

    # Unity Catalog
    async def list_schemas(self, catalog: str) -> list[dict[str, Any]]:
        data = await self.get("/api/2.1/unity-catalog/schemas", {"catalog_name": catalog})
        return data.get("schemas", []) if isinstance(data, dict) else []

    async def list_tables(self, catalog: str, schema: str) -> list[dict[str, Any]]:
        data = await self.get("/api/2.1/unity-catalog/tables",
                              {"catalog_name": catalog, "schema_name": schema})
        return data.get("tables", []) if isinstance(data, dict) else []

    # Model Serving
    async def invoke_model(self, endpoint: str, inputs: Any) -> dict[str, Any]:
        return await self.post(f"/serving-endpoints/{endpoint}/invocations", {"inputs": inputs})
