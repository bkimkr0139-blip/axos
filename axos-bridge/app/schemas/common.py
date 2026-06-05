"""공통 스키마."""
from __future__ import annotations
from typing import Literal
from pydantic import BaseModel

Status = Literal["connected", "degraded", "offline"]


class HealthResponse(BaseModel):
    status: str = "ok"
    databricks: Status = "offline"
    mxflow: Status = "offline"
    timestamp: str
    version: str
