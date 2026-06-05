"""승인/거버넌스 스키마."""
from __future__ import annotations
from typing import Any, Literal
from pydantic import BaseModel, Field


class ApprovalItem(BaseModel):
    approval_id: str
    tenant_id: str
    intent: str
    summary: str
    workflow_id: str | None = None
    risk_level: str = "medium"
    confidence: float = 0.0
    amount: float | None = None
    required_approvals: int = 1
    approvals: list[str] = Field(default_factory=list)
    status: Literal["pending", "approved", "rejected", "executed"] = "pending"
    created_at: str
    payload: dict[str, Any] = Field(default_factory=dict)


class ApprovalActionRequest(BaseModel):
    approver: str
    reason: str | None = None


class GovernanceActionRequest(BaseModel):
    target: str | None = None      # kill: agent/workflow 식별자, 없으면 global
    decision_id: str | None = None  # compensate 대상
    actor: str = "ops"
    reason: str | None = None


class PolicyDecision(BaseModel):
    decision: Literal["auto_execute", "approval_pending", "blocked"]
    required_approvals: int = 1
    reasons: list[str] = Field(default_factory=list)
