"""Simulation 서비스 — 실행 전 영향 예측(PoC mock, intent별 표준 결과)."""
from __future__ import annotations
import uuid
from typing import Any
from ..schemas.copilot import SimulationResult

_PROFILE: dict[str, dict[str, Any]] = {
    "inventory_shortage_prevention": {
        "outcome": "결품 위험 품목 발주 요청 생성 → 결품 회피", "value": 5_335_000.0, "hours": 6.0,
        "risk": "medium", "steps": ["근거 데이터 조회", "발주 수량 산정", "구매 요청서 생성", "승인 라우팅"]},
    "defect_root_cause_analysis": {
        "outcome": "불량 원인(설비 상관) 분석 → 품질 리포트", "value": 0.0, "hours": 8.0,
        "risk": "medium", "steps": ["MES 검사 조회", "상관 분석", "리포트 생성", "담당자 알림"]},
    "sales_churn_prevention": {
        "outcome": "이탈 위험 고객 후속 조치 자동화", "value": 18_000_000.0, "hours": 4.0,
        "risk": "low", "steps": ["CRM 조회", "이탈 점수 산정", "후속 액션 생성"]},
    "budget_overrun_detection": {
        "outcome": "예산 초과 경보 + 증빙 검색 + 결재", "value": 0.0, "hours": 3.0,
        "risk": "medium", "steps": ["비용 집계", "초과 항목 식별", "증빙 검색", "결재 요청"]},
    "hr_attrition_risk": {
        "outcome": "이직 위험 팀 리텐션 플랜 제안", "value": 0.0, "hours": 5.0,
        "risk": "low", "steps": ["근태/조직 조회(마스킹)", "위험 점수", "리텐션 플랜"]},
    "document_summary_approval": {
        "outcome": "문서 요약 후 승인 라우팅", "value": 0.0, "hours": 2.0,
        "risk": "low", "steps": ["문서 요약", "핵심 추출", "승인 요청"]},
}


def run(workflow_id: str, intent: str | None, payload: dict[str, Any]) -> SimulationResult:
    p = _PROFILE.get(intent or "", {
        "outcome": "표준 워크플로우 실행 시뮬레이션", "value": 0.0, "hours": 2.0,
        "risk": "low", "steps": ["입력 검증", "실행", "결과 집계"]})
    return SimulationResult(
        simulation_id="sim-" + uuid.uuid4().hex[:10], workflow_id=workflow_id,
        projected_outcome=p["outcome"], estimated_value_krw=p["value"],
        estimated_hours_saved=p["hours"], risk_level=p["risk"], steps=p["steps"])
