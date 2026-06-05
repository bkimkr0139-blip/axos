"""AX Copilot / Intent / Simulation 스키마."""
from __future__ import annotations
from typing import Any, Literal
from pydantic import BaseModel, Field

RiskLevel = Literal["low", "medium", "high"]


class CopilotRequest(BaseModel):
    user_message: str
    user_role: str = "employee"
    tenant_id: str = "default"
    auto: bool = False  # true면 정책 허용 시 즉시 실행 시도


class NextAction(BaseModel):
    label: str
    action: str


class CopilotResponse(BaseModel):
    intent: str
    summary: str
    evidence: list[dict[str, Any]] = Field(default_factory=list)
    recommended_workflow_id: str | None = None
    confidence: float = 0.0
    risk_level: RiskLevel = "medium"
    approval_required: bool = True
    decision: Literal["auto_execute", "approval_pending", "blocked"] = "approval_pending"
    execution_id: str | None = None
    approval_id: str | None = None
    next_actions: list[NextAction] = Field(default_factory=list)
    audit_event_id: str | None = None


class SimulationRequest(BaseModel):
    workflow_id: str
    intent: str | None = None
    payload: dict[str, Any] = Field(default_factory=dict)


class SimulationResult(BaseModel):
    simulation_id: str
    workflow_id: str
    projected_outcome: str
    estimated_value_krw: float = 0.0
    estimated_hours_saved: float = 0.0
    risk_level: RiskLevel = "low"
    steps: list[str] = Field(default_factory=list)
