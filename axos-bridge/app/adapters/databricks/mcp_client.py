"""Databricks MCP client skeleton — 1순위 연계 방식. 미설정 시 available=False.

MCP(Streamable HTTP) tool list/call의 최소 골격. 고객 Workspace의 Managed/External MCP
서버 URL+토큰이 주어지면 tools/list, tools/call 을 호출. 미설정 시 상위 서비스가
REST/SQL fallback 으로 전환한다.
"""
from __future__ import annotations
from typing import Any
import httpx
from ...config import get_settings


class DatabricksMcpClient:
    def __init__(self) -> None:
        s = get_settings()
        self.url = s.dbx_mcp_url
        self.token = s.dbx_mcp_token
        self.timeout = 20.0

    @property
    def available(self) -> bool:
        return bool(self.url)

    def _headers(self) -> dict[str, str]:
        h = {"Content-Type": "application/json", "Accept": "application/json, text/event-stream"}
        if self.token:
            h["Authorization"] = f"Bearer {self.token}"
        return h

    async def _rpc(self, method: str, params: dict[str, Any] | None = None) -> dict[str, Any]:
        if not self.available:
            return {"_unconfigured": True}
        body = {"jsonrpc": "2.0", "id": 1, "method": method, "params": params or {}}
        async with httpx.AsyncClient(timeout=self.timeout) as c:
            r = await c.post(self.url, headers=self._headers(), json=body)
            r.raise_for_status()
            return r.json()

    async def list_tools(self) -> list[dict[str, Any]]:
        data = await self._rpc("tools/list")
        return (data.get("result", {}) or {}).get("tools", [])

    async def call_tool(self, name: str, arguments: dict[str, Any]) -> dict[str, Any]:
        return await self._rpc("tools/call", {"name": name, "arguments": arguments})
