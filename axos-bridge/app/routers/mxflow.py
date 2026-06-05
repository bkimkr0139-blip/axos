"""MX-Flow 라우터 — workflows 목록/상세/실행/실행로그. (내부 n8n, 사용자 노출은 MX-Flow)"""
from __future__ import annotations
from fastapi import APIRouter, Depends, HTTPException
from ..dependencies import verify_api_key, tenant_context
from ..services.mxflow_service import MxFlowService
from ..services import governance_service, audit_service
from ..schemas.mxflow import WorkflowList, WorkflowDetail, ExecuteRequest, ExecuteResponse, ExecutionLogItem

router = APIRouter(prefix="/bridge/mxflow", tags=["mxflow"],
                   dependencies=[Depends(verify_api_key)])


@router.get("/workflows", response_model=WorkflowList)
async def list_workflows() -> WorkflowList:
    items, source = await MxFlowService().list_workflows()
    return WorkflowList(workflows=items, source=source)


@router.get("/workflows/{workflow_id}", response_model=WorkflowDetail)
async def workflow_detail(workflow_id: str) -> WorkflowDetail:
    try:
        return await MxFlowService().get_detail(workflow_id)
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"mxflow_detail_failed: {e}")


@router.post("/workflows/{workflow_id}/execute", response_model=ExecuteResponse)
async def execute(workflow_id: str, req: ExecuteRequest,
                  tenant: str = Depends(tenant_context)) -> ExecuteResponse:
    if governance_service.is_killed(workflow_id):
        audit_service.record("mxflow_execute", tenant_id=tenant, workflow_id=workflow_id,
                             status="failed", output={"blocked": "kill_switch"})
        raise HTTPException(status_code=423, detail="kill_switch_active")
    res = await MxFlowService().execute(workflow_id, req.payload)
    audit_service.record("mxflow_execute", tenant_id=tenant, workflow_id=workflow_id,
                         execution_id=res.get("execution_id") or None,
                         input={"trigger": req.trigger_source, "usecase": req.usecase_id},
                         output={"status": res.get("status")}, status=res.get("status", "unknown"))
    return ExecuteResponse(execution_id=res.get("execution_id", ""),
                           status=res.get("status", "unknown"), message=res.get("message", ""))


@router.get("/workflows/{workflow_id}/executions", response_model=list[ExecutionLogItem])
async def executions(workflow_id: str, limit: int = 20) -> list[ExecutionLogItem]:
    return await MxFlowService().execution_logs(workflow_id, limit)
