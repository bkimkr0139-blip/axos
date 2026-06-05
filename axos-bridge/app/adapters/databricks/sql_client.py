"""Databricks SQL Statement Execution API client. read-only 기본."""
from __future__ import annotations
from typing import Any
import httpx
from ...config import get_settings

_WRITE_PREFIXES = ("insert", "update", "delete", "merge", "drop", "alter", "create", "truncate", "grant", "revoke")


class DatabricksSqlClient:
    def __init__(self) -> None:
        s = get_settings()
        self.host = s.dbx_host
        self.token = s.dbx_token
        self.warehouse_id = s.dbx_warehouse_id
        self.allow_write = s.dbx_allow_write
        self.timeout = 60.0

    @property
    def configured(self) -> bool:
        return bool(self.host and self.token and self.warehouse_id)

    def is_write(self, sql: str) -> bool:
        return sql.strip().lower().split(" ", 1)[0] in _WRITE_PREFIXES

    async def execute(self, statement: str, limit: int = 100) -> dict[str, Any]:
        if self.is_write(statement) and not self.allow_write:
            return {"_blocked": True, "reason": "write_not_allowed (DATABRICKS_ALLOW_WRITE=false)"}
        if not self.configured:
            return {"_unconfigured": True}
        body = {
            "warehouse_id": self.warehouse_id,
            "statement": statement,
            "wait_timeout": "30s",
            "row_limit": limit,
        }
        async with httpx.AsyncClient(timeout=self.timeout) as c:
            r = await c.post(self.host + "/api/2.0/sql/statements",
                             headers={"Authorization": f"Bearer {self.token}"}, json=body)
            r.raise_for_status()
            data = r.json()
        result = data.get("result", {})
        manifest = data.get("manifest", {})
        cols = [c["name"] for c in manifest.get("schema", {}).get("columns", [])]
        return {"columns": cols, "rows": result.get("data_array", []),
                "row_count": len(result.get("data_array", []))}
