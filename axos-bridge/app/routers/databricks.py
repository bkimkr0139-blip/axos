"""Databricks 라우터 — status / catalog / search / sql."""
from __future__ import annotations
from fastapi import APIRouter, Depends
from ..dependencies import verify_api_key, tenant_context
from ..services.databricks_service import DatabricksService
from ..services import audit_service
from ..schemas.databricks import (
    DatabricksStatus, CatalogResponse, SearchRequest, SearchResponse, SqlRequest, SqlResponse,
)

router = APIRouter(prefix="/bridge/databricks", tags=["databricks"],
                   dependencies=[Depends(verify_api_key)])


@router.get("/status", response_model=DatabricksStatus)
async def status() -> DatabricksStatus:
    return DatabricksService().status()


@router.get("/catalog", response_model=CatalogResponse)
async def catalog() -> CatalogResponse:
    return await DatabricksService().catalog()


@router.post("/search", response_model=SearchResponse)
async def search(req: SearchRequest, tenant: str = Depends(tenant_context)) -> SearchResponse:
    res = await DatabricksService().search(req.query, req.filters, req.top_k)
    audit_service.record("databricks_query", tenant_id=tenant, intent="search",
                         input={"query": req.query}, output={"count": len(res.results), "source": res.source})
    return res


@router.post("/sql", response_model=SqlResponse)
async def sql(req: SqlRequest, tenant: str = Depends(tenant_context)) -> SqlResponse:
    res = await DatabricksService().run_sql(req.statement, req.limit)
    audit_service.record("databricks_query", tenant_id=tenant, intent="sql",
                         input={"statement": req.statement[:200]},
                         output={"source": res.source, "rows": res.row_count},
                         status="success" if res.source not in ("blocked",) else "failed")
    return res
