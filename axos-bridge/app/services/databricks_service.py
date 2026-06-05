"""Databricks 서비스 — MCP 우선, REST/SQL/Vector fallback, 미설정 시 mock.

고객 실사용 계정(.env)이 주입되면 동일 인터페이스로 실 연결된다(adapter 패턴).
"""
from __future__ import annotations
from typing import Any
from ..config import get_settings
from ..adapters.databricks.rest_client import DatabricksRestClient
from ..adapters.databricks.sql_client import DatabricksSqlClient
from ..adapters.databricks.vector_client import DatabricksVectorClient
from ..adapters.databricks.mcp_client import DatabricksMcpClient
from ..schemas.databricks import (
    DatabricksStatus, CatalogResponse, CatalogSchema,
    SearchResponse, SearchResultItem, SqlResponse,
)

# 미설정 시 mock 메달리온 (Data Trust Center 표시용, step1_databricks_mapping 과 일치)
_MOCK_SCHEMAS = [
    CatalogSchema(name="bronze", display_name="원본 데이터", tables=[
        {"name": "erp_orders"}, {"name": "mes_events"}, {"name": "scm_leadtime"}, {"name": "iot_sensor"}]),
    CatalogSchema(name="silver", display_name="정제 데이터", tables=[
        {"name": "items"}, {"name": "supplier_perf"}, {"name": "mes_inspection"}, {"name": "crm_contacts"}]),
    CatalogSchema(name="gold", display_name="분석용 데이터", tables=[
        {"name": "stock"}, {"name": "demand_features"}, {"name": "sales_pipeline"}, {"name": "cost_daily"}]),
]


class DatabricksService:
    def __init__(self) -> None:
        self.s = get_settings()
        self.rest = DatabricksRestClient()
        self.sql = DatabricksSqlClient()
        self.vector = DatabricksVectorClient()
        self.mcp = DatabricksMcpClient()

    def _mode(self) -> str:
        if self.mcp.available:
            return "mcp"
        if self.rest.configured:
            return "rest"
        if self.sql.configured:
            return "sql"
        return "offline"

    def status(self) -> DatabricksStatus:
        return DatabricksStatus(
            workspace=self.s.dbx_host or "(unconfigured)",
            catalog=self.s.dbx_catalog,
            configured=self.s.databricks_configured,
            mcp_available=self.mcp.available,
            sql_warehouse_available=self.sql.configured,
            vector_search_available=self.vector.configured,
            model_serving_available=bool(self.s.databricks_configured and self.s.dbx_model_endpoint),
            mode=self._mode(),
        )

    def health(self) -> str:
        return "connected" if self.s.databricks_configured else "offline"

    async def catalog(self) -> CatalogResponse:
        if self.rest.configured:
            try:
                schemas_raw = await self.rest.list_schemas(self.s.dbx_catalog)
                out: list[CatalogSchema] = []
                disp = {"bronze": "원본 데이터", "silver": "정제 데이터", "gold": "분석용 데이터"}
                for sc in schemas_raw:
                    nm = sc.get("name", "")
                    tables = await self.rest.list_tables(self.s.dbx_catalog, nm)
                    out.append(CatalogSchema(name=nm, display_name=disp.get(nm, nm),
                                             tables=[{"name": t.get("name")} for t in tables]))
                return CatalogResponse(catalog=self.s.dbx_catalog, schemas=out, source="rest")
            except Exception:
                pass
        return CatalogResponse(catalog=self.s.dbx_catalog, schemas=_MOCK_SCHEMAS, source="mock")

    async def search(self, query: str, filters: dict[str, Any], top_k: int) -> SearchResponse:
        if self.vector.configured:
            try:
                raw = await self.vector.query(query, top_k, filters)
                items: list[SearchResultItem] = []
                for row in (raw.get("result", {}).get("data_array", []) or [])[:top_k]:
                    items.append(SearchResultItem(
                        id=str(row[0]) if row else "", title=str(row[1]) if len(row) > 1 else "",
                        summary=str(row[2]) if len(row) > 2 else "", score=float(row[-1]) if row else 0.0,
                        source_table=f"{self.s.dbx_catalog}.{self.s.dbx_schema}"))
                return SearchResponse(results=items, source="vector")
            except Exception:
                pass
        # mock 근거(AX Copilot 데모용)
        mock = [
            SearchResultItem(id="doc-1", title="재고 결품 위험 리포트",
                             summary=f"'{query}' 관련 상위 근거(mock). 품목 A 결품확률 0.99.",
                             score=0.92, source_table="gold.inventory_risk",
                             lineage=["gold.stock", "silver.items", "bronze.scm_leadtime"]),
            SearchResultItem(id="doc-2", title="재주문 정책 v3", summary="안전재고+리드타임 기반 재주문점.",
                             score=0.81, source_table="silver.policy_docs"),
        ]
        return SearchResponse(results=mock[:top_k], source="mock")

    async def run_sql(self, statement: str, limit: int) -> SqlResponse:
        res = await self.sql.execute(statement, limit)
        if res.get("_blocked"):
            return SqlResponse(source="blocked", note=res.get("reason"))
        if res.get("_unconfigured"):
            return SqlResponse(source="mock", note="Databricks SQL Warehouse 미설정 — .env 주입 시 실행")
        return SqlResponse(columns=res.get("columns", []), rows=res.get("rows", []),
                           row_count=res.get("row_count", 0), source="sql")
