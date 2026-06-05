"""AX Intent Router — 자연어 요청 → 업무 intent + 추천 MX-Flow workflow + 위험도."""
from __future__ import annotations
from dataclasses import dataclass, field


@dataclass
class IntentSpec:
    intent: str
    workflow_id: str
    keywords: list[str]
    base_confidence: float
    risk_level: str
    needs_databricks: bool = True

# 가이드 §7.2 기본 intent 6종
INTENTS: list[IntentSpec] = [
    IntentSpec("inventory_shortage_prevention", "wf_inventory_purchase_request",
               ["결품", "재고", "부족", "발주", "구매", "안전재고", "리드타임"], 0.92, "medium"),
    IntentSpec("defect_root_cause_analysis", "wf_quality_issue_report",
               ["불량", "품질", "원인", "결함", "라인", "설비"], 0.86, "medium"),
    IntentSpec("sales_churn_prevention", "wf_sales_followup",
               ["이탈", "고객", "영업", "매출", "파이프라인", "해지"], 0.8, "low"),
    IntentSpec("budget_overrun_detection", "wf_finance_alert",
               ["예산", "비용", "초과", "지출", "재무"], 0.84, "medium"),
    IntentSpec("hr_attrition_risk", "wf_hr_retention_plan",
               ["이직", "퇴사", "인사", "충원", "근태", "조직"], 0.78, "low"),
    IntentSpec("document_summary_approval", "wf_document_approval",
               ["문서", "요약", "보고서", "계약", "승인", "결재"], 0.8, "low"),
]


def route(user_message: str) -> dict:
    msg = (user_message or "").lower()
    best: IntentSpec | None = None
    best_hits = 0
    for spec in INTENTS:
        hits = sum(1 for k in spec.keywords if k.lower() in msg)
        if hits > best_hits:
            best, best_hits = spec, hits
    if not best or best_hits == 0:
        return {"intent": "document_summary_approval",
                "workflow_id": "wf_document_approval", "confidence": 0.5,
                "risk_level": "medium", "matched": 0, "needs_databricks": True}
    # 매칭 수에 따라 신뢰도 소폭 가감
    conf = min(0.99, best.base_confidence + 0.02 * (best_hits - 1))
    return {"intent": best.intent, "workflow_id": best.workflow_id,
            "confidence": round(conf, 2), "risk_level": best.risk_level,
            "matched": best_hits, "needs_databricks": best.needs_databricks}
