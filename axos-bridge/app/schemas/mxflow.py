"""MX-Flow(n8n) 관련 스키마. 사용자 노출 명칭은 'MX-Flow'."""
from __future__ import annotations
from typing import Any, Literal
from pydantic import BaseModel, Field

ExecStatus = Literal["success", "failed", "running", "queued", "unknown"]


class Workflow(BaseModel):
    id: str
    name: str
    active: bool = False
    tags: list[str] = Field(default_factory=list)
    last_execution_status: ExecStatus = "unknown"
    updated_at: str | None = None


class WorkflowList(BaseModel):
    workflows: list[Workflow]
    source: str = "mxflow"  # mxflow(live) | mock


class WorkflowDetail(BaseModel):
    id: str
    name: str
    active: bool
    nodes: list[dict[str, Any]] = Field(default_factory=list)
    edges: list[dict[str, str]] = Field(default_factory=list)
    source: str = "mxflow"


class ExecuteRequest(BaseModel):
    usecase_id: str | None = None
    trigger_source: Literal["copilot", "simulation", "approval", "manual"] = "manual"
    payload: dict[str, Any] = Field(default_factory=dict)


class ExecuteResponse(BaseModel):
    execution_id: str
    status: ExecStatus
    message: str = ""


class ExecutionLogItem(BaseModel):
    execution_id: str
    workflow_id: str
    status: ExecStatus
    started_at: str | None = None
    stopped_at: str | None = None
    error: str | None = None
