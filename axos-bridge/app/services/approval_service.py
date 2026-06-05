"""승인 정책 엔진 + 승인 대기 저장소 (가이드 §8).

정책: confidence / risk_level / amount / 보안·외부쓰기 조건을 함께 판단.
"""
from __future__ import annotations
import uuid
from datetime import datetime, timezone
from typing import Any
from ..schemas.approvals import ApprovalItem, PolicyDecision

AMOUNT_THRESHOLD = 1_000_000          # 자동실행 허용 금액 상한
DUAL_THRESHOLD = 10_000_000           # 이중승인 임계


def evaluate(confidence: float, risk_level: str, amount: float | None = None,
             has_security_data: bool = False, has_external_write: bool = False) -> PolicyDecision:
    reasons: list[str] = []
    amt = amount or 0
    # 차단/관리자 검토
    if confidence < 0.7 or risk_level == "high":
        reasons.append("저신뢰 또는 고위험 → 재분석/관리자 검토")
        return PolicyDecision(decision="blocked", required_approvals=1, reasons=reasons)
    # 보안/외부쓰기/고액 → 승인 필수
    required = 1
    must_approve = False
    if has_security_data:
        must_approve = True; reasons.append("개인정보/보안 데이터 포함 → 보안 승인 필수")
    if has_external_write:
        must_approve = True; reasons.append("외부 시스템 쓰기 → 결재 필수")
    if amt > DUAL_THRESHOLD:
        must_approve = True; required = 2; reasons.append(f"금액 {amt:,} > 이중승인 임계 → 팀장/임원 2인")
    elif amt > AMOUNT_THRESHOLD:
        must_approve = True; reasons.append(f"금액 {amt:,} > 임계 {AMOUNT_THRESHOLD:,} → 승인 필요")
    if risk_level == "medium":
        must_approve = True; reasons.append("중위험 → 승인 대기")
    # 자동 실행 조건
    if not must_approve and confidence >= 0.9 and risk_level == "low" and amt < AMOUNT_THRESHOLD:
        reasons.append("고신뢰·저위험·소액 → 자동 실행")
        return PolicyDecision(decision="auto_execute", required_approvals=0, reasons=reasons)
    return PolicyDecision(decision="approval_pending", required_approvals=max(1, required), reasons=reasons)


# ── 승인 대기 저장소 (PoC: in-memory) ──
_PENDING: dict[str, ApprovalItem] = {}


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def create_pending(*, tenant_id: str, intent: str, summary: str, workflow_id: str | None,
                   risk_level: str, confidence: float, amount: float | None,
                   required_approvals: int, payload: dict[str, Any]) -> ApprovalItem:
    aid = "apr-" + uuid.uuid4().hex[:10]
    item = ApprovalItem(approval_id=aid, tenant_id=tenant_id, intent=intent, summary=summary,
                        workflow_id=workflow_id, risk_level=risk_level, confidence=confidence,
                        amount=amount, required_approvals=required_approvals, approvals=[],
                        status="pending", created_at=_now(), payload=payload)
    _PENDING[aid] = item
    return item


def list_pending(tenant_id: str | None = None) -> list[ApprovalItem]:
    items = [i for i in _PENDING.values() if i.status == "pending"]
    if tenant_id:
        items = [i for i in items if i.tenant_id == tenant_id]
    return items


def get(approval_id: str) -> ApprovalItem | None:
    return _PENDING.get(approval_id)


def approve(approval_id: str, approver: str) -> dict[str, Any]:
    item = _PENDING.get(approval_id)
    if not item or item.status != "pending":
        return {"ok": False, "reason": "not_found_or_resolved"}
    if not approver or approver in ("ai",) or approver.startswith("agent:"):
        return {"ok": False, "reason": "SoD: 판단 주체는 승인 불가"}
    if approver in item.approvals:
        return {"ok": False, "reason": "SoD: 동일인 중복 승인 불가"}
    item.approvals.append(approver)
    if len(item.approvals) < item.required_approvals:
        return {"ok": True, "pending_more_approval": True,
                "approvals": item.approvals, "need": item.required_approvals}
    item.status = "approved"
    return {"ok": True, "approved": True, "approvals": item.approvals, "item": item}


def reject(approval_id: str, approver: str, reason: str | None) -> dict[str, Any]:
    item = _PENDING.get(approval_id)
    if not item or item.status != "pending":
        return {"ok": False, "reason": "not_found_or_resolved"}
    item.status = "rejected"
    return {"ok": True, "rejected": True, "by": approver, "reason": reason}
