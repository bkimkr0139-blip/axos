"""AX Copilot 실행 루프 — intent → Databricks 근거 → simulation → 승인정책 → 실행/결재 → audit."""
from __future__ import annotations
from fastapi import APIRouter, Depends
from ..dependencies import verify_api_key, tenant_context
from ..services import intent_router, approval_service, simulation_service, audit_service
from ..services.databricks_service import DatabricksService
from ..schemas.copilot import (
    CopilotRequest, CopilotResponse, NextAction, SimulationRequest, SimulationResult,
)

router = APIRouter(prefix="/bridge/copilot", tags=["copilot"],
                   dependencies=[Depends(verify_api_key)])

# 외부 시스템 쓰기를 동반하는 intent (발주 등) → 승인 가중
_EXTERNAL_WRITE = {"inventory_shortage_prevention"}
_SECURITY = {"hr_attrition_risk"}  # 개인정보 포함


@router.post("/execute", response_model=CopilotResponse)
async def execute(req: CopilotRequest, tenant_hdr: str = Depends(tenant_context)) -> CopilotResponse:
    # 테넌트: 본문 tenant_id 우선(계약), 없으면 헤더(x-tenant-id)
    tenant = req.tenant_id if req.tenant_id and req.tenant_id != "default" else tenant_hdr
    r = intent_router.route(req.user_message)
    intent, wf, conf, risk = r["intent"], r["workflow_id"], r["confidence"], r["risk_level"]

    # 근거 조회 (Databricks AI/Vector Search, 미설정 시 mock)
    search = await DatabricksService().search(req.user_message, {"role": req.user_role}, top_k=5)
    evidence = [it.model_dump() for it in search.results]

    # 시뮬레이션(영향 예측)
    sim = simulation_service.run(wf, intent, {})
    amount = sim.estimated_value_krw or None

    # 승인 정책
    policy = approval_service.evaluate(
        confidence=conf, risk_level=risk, amount=amount,
        has_security_data=intent in _SECURITY,
        has_external_write=intent in _EXTERNAL_WRITE)

    approval_id = None
    decision = policy.decision
    if decision == "approval_pending":
        item = approval_service.create_pending(
            tenant_id=tenant, intent=intent, summary=f"{intent} ({wf})",
            workflow_id=wf, risk_level=risk, confidence=conf, amount=amount,
            required_approvals=policy.required_approvals,
            payload={"user_message": req.user_message, "evidence_refs": [e["id"] for e in evidence]})
        approval_id = item.approval_id

    next_actions = [NextAction(label="시뮬레이션 보기", action="run_simulation")]
    if decision == "auto_execute":
        next_actions.append(NextAction(label="워크플로우 실행", action="execute_workflow"))
    elif decision == "approval_pending":
        next_actions.append(NextAction(label="결재 요청 확인", action="open_approval"))

    event_id = audit_service.record(
        "copilot", tenant_id=tenant, user_id=req.user_role, intent=intent,
        input={"user_message": req.user_message},
        output={"decision": decision, "confidence": conf, "risk": risk, "workflow": wf},
        evidence_refs=[e["id"] for e in evidence], workflow_id=wf, approval_id=approval_id,
        status="pending" if decision == "approval_pending" else "success")

    summary = {
        "inventory_shortage_prevention": "결품 위험 품목을 찾아 구매 요청을 준비했습니다.",
        "defect_root_cause_analysis": "불량 원인 분석과 품질 리포트를 준비했습니다.",
        "sales_churn_prevention": "이탈 위험 고객 후속 조치를 준비했습니다.",
        "budget_overrun_detection": "예산 초과 항목과 증빙을 정리했습니다.",
        "hr_attrition_risk": "이직 위험 신호와 리텐션 플랜을 준비했습니다.",
        "document_summary_approval": "문서 요약과 승인 요청을 준비했습니다.",
    }.get(intent, "요청을 분석했습니다.")

    return CopilotResponse(
        intent=intent, summary=summary, evidence=evidence, recommended_workflow_id=wf,
        confidence=conf, risk_level=risk, approval_required=(decision != "auto_execute"),
        decision=decision, approval_id=approval_id, next_actions=next_actions,
        audit_event_id=event_id)


@router.post("/simulate", response_model=SimulationResult)
async def simulate(req: SimulationRequest) -> SimulationResult:
    return simulation_service.run(req.workflow_id, req.intent, req.payload)
