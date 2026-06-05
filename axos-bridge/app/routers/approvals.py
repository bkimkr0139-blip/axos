"""승인 라우터 — 대기 목록 / 승인 / 거부. (RBAC·SoD는 approval_service)"""
from __future__ import annotations
from fastapi import APIRouter, Depends
from ..dependencies import verify_api_key, tenant_context
from ..services import approval_service, audit_service
from ..schemas.approvals import ApprovalItem, ApprovalActionRequest

router = APIRouter(prefix="/bridge/approvals", tags=["approvals"],
                   dependencies=[Depends(verify_api_key)])


@router.get("/pending", response_model=list[ApprovalItem])
async def pending(tenant: str = Depends(tenant_context)) -> list[ApprovalItem]:
    return approval_service.list_pending(tenant)


@router.post("/{approval_id}/approve")
async def approve(approval_id: str, req: ApprovalActionRequest,
                  tenant: str = Depends(tenant_context)) -> dict:
    res = approval_service.approve(approval_id, req.approver)
    if res.get("ok"):
        audit_service.record("approval", tenant_id=tenant, user_id=req.approver,
                             approval_id=approval_id,
                             output={"approved": res.get("approved", False),
                                     "pending_more": res.get("pending_more_approval", False)},
                             status="success" if res.get("approved") else "pending")
    return res


@router.post("/{approval_id}/reject")
async def reject(approval_id: str, req: ApprovalActionRequest,
                 tenant: str = Depends(tenant_context)) -> dict:
    res = approval_service.reject(approval_id, req.approver, req.reason)
    if res.get("ok"):
        audit_service.record("approval", tenant_id=tenant, user_id=req.approver,
                             approval_id=approval_id, output={"rejected": True}, status="failed")
    return res
