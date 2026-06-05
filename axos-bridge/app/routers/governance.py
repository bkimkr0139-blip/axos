"""거버넌스 라우터 — kill / unkill / compensate / state + audit 조회."""
from __future__ import annotations
from fastapi import APIRouter, Depends
from ..dependencies import verify_api_key, tenant_context
from ..services import governance_service, audit_service
from ..schemas.approvals import GovernanceActionRequest

router = APIRouter(prefix="/bridge/governance", tags=["governance"],
                   dependencies=[Depends(verify_api_key)])


@router.get("/state")
async def state() -> dict:
    return governance_service.state()


@router.post("/kill")
async def kill(req: GovernanceActionRequest, tenant: str = Depends(tenant_context)) -> dict:
    st = governance_service.kill(req.target)
    audit_service.record("kill", tenant_id=tenant, user_id=req.actor,
                         output={"target": req.target or "global"})
    return {"ok": True, "killed": st}


@router.post("/unkill")
async def unkill(req: GovernanceActionRequest, tenant: str = Depends(tenant_context)) -> dict:
    st = governance_service.unkill(req.target)
    audit_service.record("kill", tenant_id=tenant, user_id=req.actor,
                         output={"unkill": req.target or "global"})
    return {"ok": True, "killed": st}


@router.post("/compensate")
async def compensate(req: GovernanceActionRequest, tenant: str = Depends(tenant_context)) -> dict:
    # 보상은 실행 어댑터(ERP/MX-Flow)로 위임. PoC: audit 기록 + 보상 지시 반환.
    eid = audit_service.record("compensate", tenant_id=tenant, user_id=req.actor,
                               input={"decision_id": req.decision_id, "reason": req.reason},
                               status="success")
    return {"ok": True, "decision_id": req.decision_id, "compensation": "recorded",
            "audit_event_id": eid,
            "note": "실 보상은 MX-Flow 보상 워크플로우 또는 ERP cancel 어댑터로 연결"}


@router.get("/audit")
async def audit(limit: int = 50, tenant: str = Depends(tenant_context)) -> dict:
    return {"events": audit_service.recent(limit, tenant)}
