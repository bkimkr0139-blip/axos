"""n8n REST API client (MX-Flow 내부 구현). 사용자 노출 명칭은 'MX-Flow'."""
from __future__ import annotations
from typing import Any
import httpx
from ...config import get_settings


class N8nClient:
    def __init__(self) -> None:
        s = get_settings()
        self.base = s.mxflow_base
        self.api_key = s.mxflow_api_key
        self.timeout = 10.0

    def _headers(self) -> dict[str, str]:
        h = {"Accept": "application/json"}
        if self.api_key:
            h["X-N8N-API-KEY"] = self.api_key
        return h

    async def _get(self, path: str, params: dict[str, Any] | None = None) -> dict[str, Any]:
        async with httpx.AsyncClient(timeout=self.timeout) as c:
            r = await c.get(self.base + path, headers=self._headers(), params=params)
            r.raise_for_status()
            return r.json()

    async def ping(self) -> bool:
        """webhook/health 로 n8n 가용성 확인 (인증 불필요 경로)."""
        try:
            async with httpx.AsyncClient(timeout=5.0) as c:
                r = await c.get(self.base + "/webhook/health")
                return r.status_code < 300
        except Exception:
            return False

    async def list_workflows(self, limit: int = 100) -> list[dict[str, Any]]:
        data = await self._get("/api/v1/workflows", {"limit": limit})
        return data.get("data", data if isinstance(data, list) else [])

    async def get_workflow(self, workflow_id: str) -> dict[str, Any]:
        return await self._get(f"/api/v1/workflows/{workflow_id}")

    async def list_executions(self, workflow_id: str | None = None, limit: int = 20) -> list[dict[str, Any]]:
        params: dict[str, Any] = {"limit": limit}
        if workflow_id:
            params["workflowId"] = workflow_id
        data = await self._get("/api/v1/executions", params)
        return data.get("data", [])

    async def get_execution(self, execution_id: str) -> dict[str, Any]:
        return await self._get(f"/api/v1/executions/{execution_id}")
