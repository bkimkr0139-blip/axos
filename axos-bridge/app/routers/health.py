"""Health — Databricks/MX-Flow 상태 요약."""
from __future__ import annotations
from datetime import datetime, timezone
from fastapi import APIRouter
from .. import __version__
from ..schemas.common import HealthResponse
from ..services.mxflow_service import MxFlowService
from ..services.databricks_service import DatabricksService

router = APIRouter(tags=["health"])


@router.get("/bridge/health", response_model=HealthResponse)
async def health() -> HealthResponse:
    mx = await MxFlowService().status()
    dbx = DatabricksService().health()
    return HealthResponse(
        status="ok",
        databricks=dbx,  # connected | offline
        mxflow=mx,
        timestamp=datetime.now(timezone.utc).isoformat(),
        version=__version__,
    )
