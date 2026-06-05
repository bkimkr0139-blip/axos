"""Databricks Vector Search / AI Search client. 미설정 시 graceful."""
from __future__ import annotations
from typing import Any
import httpx
from ...config import get_settings


class DatabricksVectorClient:
    def __init__(self) -> None:
        s = get_settings()
        self.host = s.dbx_host
        self.token = s.dbx_token
        self.endpoint = s.dbx_vector_endpoint
        self.index = s.dbx_vector_index
        self.timeout = 20.0

    @property
    def configured(self) -> bool:
        return bool(self.host and self.token and self.index)

    async def query(self, query_text: str, top_k: int = 5,
                    filters: dict[str, Any] | None = None) -> dict[str, Any]:
        if not self.configured:
            return {"_unconfigured": True}
        body: dict[str, Any] = {"query_text": query_text, "num_results": top_k}
        if filters:
            body["filters_json"] = filters
        path = f"/api/2.0/vector-search/indexes/{self.index}/query"
        async with httpx.AsyncClient(timeout=self.timeout) as c:
            r = await c.post(self.host + path,
                             headers={"Authorization": f"Bearer {self.token}"}, json=body)
            r.raise_for_status()
            return r.json()
